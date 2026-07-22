"""Persistence for the preset library: caching, atomic writes, and recovery.

The library is a single JSON file the user is invited to hand-edit, which sets
the constraints here:

* it lives under ComfyUI's *user* directory, not this package, so reinstalling
  or updating the node cannot destroy it. The bundled ``data/`` directory only
  seeds a library that does not exist yet;
* writes go to a temporary file and are swapped in with os.replace(), so an
  interrupted write leaves the previous library intact rather than a truncated
  one. The prior contents are copied aside first, giving one generation of
  known-good backup;
* reads are cached against the file's stat signature, so external edits are
  picked up without polling, and a corrupt file is refused rather than allowed
  to overwrite good data.

Usage timestamps live in a separate ``usage.json``: touching a preset is a
frequent, low-value write, and mixing it into the library would rewrite the
whole file — and invalidate the node's cache fingerprint — every time a preset
was merely used.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import uuid
from copy import deepcopy
from pathlib import Path
from threading import RLock
from typing import Any

from .preset_model import (
    PresetValidationError,
    SCHEMA_VERSION,
    normalize_library,
    repair_library,
    validate_library,
)

LOGGER = logging.getLogger("comfyui.text_preset_loader")
BASE_DIR = Path(__file__).resolve().parent
BUNDLED_DATA_DIR = BASE_DIR / "data"

try:
    import folder_paths

    USER_ROOT = Path(folder_paths.get_user_directory())
except Exception:  # pragma: no cover - only used outside ComfyUI
    USER_ROOT = BUNDLED_DATA_DIR.parent

DATA_DIR = USER_ROOT / "text-preset-loader"
PREVIEWS_DIR = DATA_DIR / "previews"
JSON_PATH = DATA_DIR / "presets.json"
BACKUP_PATH = DATA_DIR / "presets.backup.json"
USAGE_PATH = DATA_DIR / "usage.json"
USAGE_BACKUP_PATH = DATA_DIR / "usage.backup.json"

_lock = RLock()
_initialized = False
_cache: dict[str, dict[str, Any]] | None = None
_cache_signature: tuple[int, int, int] | None = None
_last_storage_error: str | None = None
_usage_cache: dict[str, str] | None = None
_usage_signature: tuple[int, int, int] | None = None


class PresetStorageError(RuntimeError):
    pass


def _signature(path: Path) -> tuple[int, int, int] | None:
    """Cheap change-detector for the cache.

    Size alone misses same-length edits and mtime alone can be too coarse, so
    both timestamps and size are combined. None means the file is absent, which
    is itself a distinguishable state.
    """
    try:
        stat = path.stat()
        return stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size
    except FileNotFoundError:
        return None


def _fsync_directory(directory: Path) -> None:
    """Flush the directory entry so a rename survives a crash.

    POSIX only: on Windows a directory cannot be opened for fsync, and the
    os.replace() itself is already atomic there.
    """
    if os.name == "nt":
        return
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_write_json(path: Path, backup_path: Path, payload: Any) -> None:
    """Replace `path` with `payload`, keeping the previous contents as a backup.

    Ordering matters: the new file is written and flushed, the current file is
    copied to the backup, and only then is the swap performed. At every point
    either the old or the new library is complete on disk — a crash never leaves
    both damaged.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.stem}-", suffix=".tmp", dir=str(path.parent)
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())

        if path.exists():
            backup_descriptor, backup_temporary_name = tempfile.mkstemp(
                prefix=f".{backup_path.stem}-", suffix=".tmp", dir=str(path.parent)
            )
            os.close(backup_descriptor)
            backup_temporary_path = Path(backup_temporary_name)
            try:
                shutil.copy2(path, backup_temporary_path)
                # "r+b", not "rb": on Windows os.fsync() maps to _commit(), which
                # requires a handle opened for writing and raises EBADF otherwise.
                with backup_temporary_path.open("r+b") as backup_handle:
                    os.fsync(backup_handle.fileno())
                os.replace(backup_temporary_path, backup_path)
            finally:
                backup_temporary_path.unlink(missing_ok=True)

        os.replace(temporary_path, path)
        _fsync_directory(path.parent)
    finally:
        temporary_path.unlink(missing_ok=True)


def _decode_library(raw: Any) -> tuple[dict[str, dict[str, Any]], bool, dict[str, str]]:
    """Return (presets, needs_rewrite, renames) for a freshly parsed library.

    Names that fail validation are repaired rather than rejected: one bad entry
    in a hand-edited file must not take the whole library down with it. Any
    repair sets needs_rewrite so the corrected names are persisted once.
    """
    try:
        if isinstance(raw, dict) and "presets" in raw:
            try:
                version = int(raw.get("schema_version", 0) or 0)
            except (TypeError, ValueError) as exc:
                raise PresetStorageError("Preset library schema version is invalid") from exc
            if version > SCHEMA_VERSION:
                raise PresetStorageError(
                    f"Preset library schema {version} is newer than supported schema {SCHEMA_VERSION}"
                )
            source, renames = repair_library(raw.get("presets"))
            presets = normalize_library(source)
            validate_library(presets)
            return presets, version != SCHEMA_VERSION or bool(renames), renames
        source, renames = repair_library(raw)
        presets = normalize_library(source)
        validate_library(presets)
        return presets, True, renames
    except PresetValidationError as exc:
        raise PresetStorageError(f"Preset library validation failed: {exc}") from exc


def _log_renames(renames: dict[str, str]) -> None:
    if not renames:
        return
    LOGGER.warning("Repaired %d invalid preset name(s):", len(renames))
    for before, after in renames.items():
        LOGGER.warning("  %r -> %r", before, after)


def _read_library_file(path: Path) -> tuple[dict[str, dict[str, Any]], bool, dict[str, str]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PresetStorageError(f"Preset library is missing: {path}") from exc
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PresetStorageError(f"Preset library is unreadable: {exc}") from exc
    return _decode_library(raw)


def _copy_preview_tree(source: Path, destination: Path) -> None:
    if not source.exists():
        return
    destination.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        if item.is_file():
            target = destination / item.name
            if not target.exists():
                shutil.copy2(item, target)



def _migrate_preview_references(presets: dict[str, dict[str, Any]]) -> bool:
    """Replace legacy key-derived preview names with unique opaque filenames."""
    changed = False
    seen: set[str] = set()
    for key, entry in presets.items():
        raw_name = entry.get("preview")
        if not raw_name:
            legacy_name = key.replace("/", "_") + ".jpg"
            if (PREVIEWS_DIR / legacy_name).is_file():
                raw_name = legacy_name
            else:
                continue
        name = str(raw_name)
        source = PREVIEWS_DIR / name
        safe_name = Path(name).name == name and not any(ord(char) < 32 for char in name)
        opaque = (
            len(name) == 36
            and name.endswith(".jpg")
            and all(char in "0123456789abcdef" for char in name[:-4])
        )
        if safe_name and opaque and name not in seen and source.is_file():
            seen.add(name)
            continue
        if not safe_name or not source.is_file():
            LOGGER.warning("Removing invalid or missing preview reference for %s", key)
            entry["preview"] = None
            entry["preview_version"] = int(entry.get("preview_version", 0) or 0) + 1
            changed = True
            continue

        destination_name = f"{uuid.uuid4().hex}.jpg"
        destination = PREVIEWS_DIR / destination_name
        shutil.copy2(source, destination)
        entry["preview"] = destination_name
        entry["preview_version"] = int(entry.get("preview_version", 0) or 0) + 1
        seen.add(destination_name)
        changed = True
    return changed


def ensure_storage() -> None:
    global _cache, _cache_signature, _last_storage_error
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PREVIEWS_DIR.mkdir(parents=True, exist_ok=True)
        if not JSON_PATH.exists():
            bundled_json = BUNDLED_DATA_DIR / "presets.json"
            if bundled_json.exists():
                shutil.copy2(bundled_json, JSON_PATH)
                _copy_preview_tree(BUNDLED_DATA_DIR / "previews", PREVIEWS_DIR)
            else:
                _atomic_write_json(
                    JSON_PATH,
                    BACKUP_PATH,
                    {"schema_version": SCHEMA_VERSION, "presets": {}},
                )

        try:
            presets, needs_migration, renames = _read_library_file(JSON_PATH)
            _log_renames(renames)
            preview_migrated = _migrate_preview_references(presets)
            _cache = presets
            _cache_signature = _signature(JSON_PATH)
            _last_storage_error = None
            if needs_migration or preview_migrated:
                _atomic_write_json(
                    JSON_PATH,
                    BACKUP_PATH,
                    {"schema_version": SCHEMA_VERSION, "presets": presets},
                )
                _cache_signature = _signature(JSON_PATH)
        except PresetStorageError as exc:
            _last_storage_error = str(exc)
            LOGGER.error("Preset library could not be loaded: %s", exc)
            if BACKUP_PATH.exists():
                try:
                    _cache, _, _ = _read_library_file(BACKUP_PATH)
                    _cache_signature = _signature(JSON_PATH)
                    LOGGER.warning("Using the last known good preset library backup")
                except PresetStorageError:
                    _cache = None
                    _cache_signature = None


def _ensure_initialized() -> None:
    """Seed and load the library on first use.

    Every public entry point calls this, so importing the module touches no
    filesystem — the domain layer stays loadable without a user directory.
    Failures are recorded rather than raised: ComfyUI must still start when the
    user directory is unavailable, with the node reporting the problem instead.
    """
    global _initialized, _last_storage_error
    with _lock:
        if _initialized:
            return
        _initialized = True
        try:
            ensure_storage()
        except Exception as exc:  # keep ComfyUI loadable when the user dir is unavailable
            _last_storage_error = f"Preset storage could not be initialized: {exc}"
            LOGGER.exception(_last_storage_error)


def storage_warning() -> str | None:
    _ensure_initialized()
    return _last_storage_error


def read_presets(*, strict: bool = False, copy_data: bool = False) -> dict[str, dict[str, Any]]:
    """Return the library, re-reading it only when the file has changed.

    `copy_data` must be True for any caller that intends to mutate the result:
    the default returns the live cache, which the node's resolution memo relies
    on being identity-stable across calls.

    `strict` decides what a broken library means to the caller. Mutating routes
    pass strict=True and get an exception, so a corrupt file is never used as
    the basis for a write. Read-only paths keep serving the last good snapshot.
    """
    global _cache, _cache_signature, _last_storage_error
    _ensure_initialized()
    with _lock:
        current_signature = _signature(JSON_PATH)
        if _cache is not None and current_signature == _cache_signature:
            if strict and _last_storage_error:
                raise PresetStorageError(_last_storage_error)
            return deepcopy(_cache) if copy_data else _cache

        try:
            presets, _, renames = _read_library_file(JSON_PATH)
            _log_renames(renames)
            _cache = presets
            _cache_signature = current_signature
            _last_storage_error = None
        except PresetStorageError as exc:
            _last_storage_error = str(exc)
            _cache_signature = current_signature
            if strict or _cache is None:
                raise
            LOGGER.error("Refusing to refresh an invalid preset library: %s", exc)
        return deepcopy(_cache) if copy_data else _cache


def write_presets(presets: dict[str, dict[str, Any]]) -> None:
    global _cache, _cache_signature, _last_storage_error
    _ensure_initialized()
    with _lock:
        if _last_storage_error:
            raise PresetStorageError(
                "Preset library is invalid. Restore or repair presets.json before making changes."
            )
        normalized = normalize_library(presets)
        _atomic_write_json(
            JSON_PATH,
            BACKUP_PATH,
            {"schema_version": SCHEMA_VERSION, "presets": normalized},
        )
        _cache = normalized
        _cache_signature = _signature(JSON_PATH)
        _last_storage_error = None


def _read_usage_file(path: Path) -> dict[str, str]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        LOGGER.warning("Ignoring unreadable usage metadata: %s", exc)
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(key): str(value) for key, value in raw.items() if key and value}


def read_usage(*, copy_data: bool = False) -> dict[str, str]:
    global _usage_cache, _usage_signature
    _ensure_initialized()
    with _lock:
        current_signature = _signature(USAGE_PATH)
        if _usage_cache is None or current_signature != _usage_signature:
            _usage_cache = _read_usage_file(USAGE_PATH)
            _usage_signature = current_signature
        return deepcopy(_usage_cache) if copy_data else _usage_cache


def write_usage(usage: dict[str, str]) -> None:
    global _usage_cache, _usage_signature
    _ensure_initialized()
    with _lock:
        cleaned = {str(key): str(value) for key, value in usage.items() if key and value}
        _atomic_write_json(USAGE_PATH, USAGE_BACKUP_PATH, cleaned)
        _usage_cache = cleaned
        _usage_signature = _signature(USAGE_PATH)


def presets_with_usage() -> dict[str, dict[str, Any]]:
    presets = read_presets(copy_data=True)
    usage = read_usage()
    for key, entry in presets.items():
        entry["last_used_at"] = usage.get(key) or entry.get("last_used_at")
    return presets
