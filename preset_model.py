"""The preset data model: shape, validation, and resolution. No I/O.

One shape for everything. A preset is an ordered list of *parts*; a part is
either a reference to another preset (``{"key": ...}``) or inline text
(``{"text": ...}``). Resolving a preset concatenates its enabled parts, in
order, joined by blank lines — following references recursively. There is no
separate "composition" type: a preset that happens to reference others simply
displays differently.

Names double as both the category path (``Camera/Portrait/close_up``) and, by
convention, the reuse namespace: anything under ``Parts/`` is a fragment meant
for composition rather than a prompt to select on its own. Because a name has to
survive being a path segment on any OS, validate_key() is stricter than the
filesystem the library currently sits on.

web/core/model.js mirrors this file's shape rules exactly (parts, resolution,
canonicalisation). Its name-validation is a deliberately partial subset, kept
only for inline editor feedback — this file is the authority on names.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import PurePath
from typing import Any

SCHEMA_VERSION = 2
MAX_KEY_LENGTH = 240
MAX_PARTS = 256
MAX_TEXT_LENGTH = 1_000_000
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
_INVALID_PATH_CHARS = set('<>:"|?*\\')


class PresetValidationError(ValueError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def canonicalize_key(value: Any) -> str:
    """Normalise a name without judging it: trim, drop leading slashes, and fix
    the case of the Parts/ prefix so ``parts/x`` and ``Parts/x`` are one preset
    rather than two that shadow each other.
    """
    key = str(value or "").strip()
    key = key.lstrip("/")
    if key.casefold().startswith("parts/"):
        key = "Parts/" + key.split("/", 1)[1]
    return key


def validate_key(value: Any) -> str:
    """Return the canonical name, or raise if it cannot be used as one.

    Names become path segments in the previews directory and travel between
    machines, so the rules are the strictest common denominator rather than
    whatever the current filesystem tolerates: Windows' reserved device names
    and forbidden characters are rejected everywhere, as are trailing dots and
    spaces (silently stripped by Windows) and traversal segments.
    """
    key = canonicalize_key(value)
    if not key:
        raise PresetValidationError("Preset name cannot be empty")
    if len(key) > MAX_KEY_LENGTH:
        raise PresetValidationError(f"Preset name cannot exceed {MAX_KEY_LENGTH} characters")
    if any(ord(char) < 32 or char in _INVALID_PATH_CHARS for char in key):
        raise PresetValidationError("Preset name contains unsupported characters")

    segments = key.split("/")
    if any(not segment for segment in segments):
        raise PresetValidationError("Preset name cannot contain empty path segments")
    for segment in segments:
        if segment in {".", ".."}:
            raise PresetValidationError("Preset name cannot contain '.' or '..' segments")
        if segment.endswith((" ", ".")):
            raise PresetValidationError("Preset path segments cannot end with a space or period")
        stem = PurePath(segment).stem.upper()
        if stem in _WINDOWS_RESERVED:
            raise PresetValidationError(f'Preset path segment "{segment}" is reserved')
    if key == "Parts":
        raise PresetValidationError("Reusable parts require a name under Parts/")
    return key


def repair_key(value: Any, taken: set[str] | None = None) -> str:
    """Coerce a name that ``validate_key`` rejects into the closest valid one.

    presets.json is meant to be hand-editable, so a single bad name must never
    make the whole library unusable. Every rule in ``validate_key`` gets a
    mechanical coercion here; anything left over falls back to "Untitled".
    ``taken`` is the set of names already claimed, so repairs cannot collide.
    """
    key = canonicalize_key(value)

    # A backslash is almost always a separator typed on Windows, so it becomes
    # "/" rather than being scrubbed. Everything else illegal becomes "_".
    key = "".join(
        "/" if char == "\\"
        else "_" if (ord(char) < 32 or char in _INVALID_PATH_CHARS)
        else char
        for char in key
    )

    segments: list[str] = []
    for segment in key.split("/"):
        segment = segment.strip().rstrip(" .")
        if not segment or segment in {".", ".."}:
            continue  # empty and traversal segments are dropped outright
        if PurePath(segment).stem.upper() in _WINDOWS_RESERVED:
            segment += "_"
        segments.append(segment)

    key = "/".join(segments)
    if len(key) > MAX_KEY_LENGTH:
        key = key[:MAX_KEY_LENGTH].rstrip(" ./")
    if key.casefold() == "parts":
        key = "Parts/untitled"

    try:
        key = validate_key(key)
    except PresetValidationError:
        key = "Untitled"

    taken = taken or set()
    if key not in taken:
        return key
    counter = 2
    while f"{key}-{counter}" in taken:
        counter += 1
    return f"{key}-{counter}"


def repair_library(data: Any) -> tuple[dict[str, Any], dict[str, str]]:
    """Rewrite unusable preset names in a raw library, references included.

    Returns the raw library keyed by valid names plus a ``{before: after}`` map
    of everything that moved, so the caller can log it and persist the result.
    Composition references are rewritten through the same map — otherwise a
    repaired name would orphan every composition that pointed at it.
    """
    if not isinstance(data, dict):
        return {}, {}

    repaired: dict[str, Any] = {}
    renames: dict[str, str] = {}
    for raw_key, raw_entry in data.items():
        raw_name = str(raw_key)
        if raw_name.startswith("__"):
            repaired[raw_name] = raw_entry
            continue
        try:
            key = validate_key(raw_key)
            if key in repaired:
                raise PresetValidationError("Name already taken")
        except PresetValidationError:
            key = repair_key(raw_key, set(repaired))
        if key != raw_name:
            renames[raw_name] = key
        repaired[key] = raw_entry

    for entry in repaired.values() if renames else ():
        parts = entry.get("parts") if isinstance(entry, dict) else None
        if not isinstance(parts, list):
            continue
        for index, part in enumerate(parts):
            if isinstance(part, str) and part in renames:
                parts[index] = renames[part]
            elif isinstance(part, dict) and part.get("key") in renames:
                part["key"] = renames[part["key"]]
    return repaired, renames


def _normalize_enabled(value: Any, *, strict: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if strict:
        raise PresetValidationError("Part enabled must be a boolean")
    return True


def normalize_parts(parts: Any, *, strict: bool = False) -> list[dict[str, Any]]:
    if parts is None:
        return []
    if not isinstance(parts, list):
        if strict:
            raise PresetValidationError("Parts must be a list")
        return []
    if len(parts) > MAX_PARTS:
        raise PresetValidationError(f"A preset cannot contain more than {MAX_PARTS} parts")

    normalized: list[dict[str, Any]] = []
    for index, part in enumerate(parts):
        if isinstance(part, str):
            key = validate_key(part) if strict else canonicalize_key(part)
            if key:
                normalized.append({"key": key, "enabled": True})
            continue
        if not isinstance(part, dict):
            if strict:
                raise PresetValidationError(f"Part {index + 1} must be an object")
            continue

        raw_key = part.get("key", "")
        raw_text = part.get("text", "")
        enabled = _normalize_enabled(part.get("enabled", True), strict=strict)
        key = validate_key(raw_key) if raw_key and strict else canonicalize_key(raw_key)
        text = str(raw_text or "")
        if len(text) > MAX_TEXT_LENGTH:
            raise PresetValidationError(f"Part {index + 1} text is too large")

        if key:
            normalized.append({"key": key, "enabled": enabled})
        elif text.strip():
            label = str(part.get("label", "Custom") or "Custom").strip() or "Custom"
            normalized.append({"text": text, "label": label[:80], "enabled": enabled})
        elif strict:
            raise PresetValidationError(f"Part {index + 1} must reference a preset or contain text")
    return normalized


def _non_negative_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return default


def normalize_entry(entry: Any, *, strict: bool = False) -> dict[str, Any]:
    if strict and not isinstance(entry, dict):
        raise PresetValidationError("Each preset entry must be an object")
    source = entry if isinstance(entry, dict) else {}
    parts = normalize_parts(source.get("parts"), strict=strict) if "parts" in source else []
    if not parts and str(source.get("text", "")).strip():
        text = str(source.get("text", ""))
        if len(text) > MAX_TEXT_LENGTH:
            raise PresetValidationError("Preset text is too large")
        parts = [{"text": text, "label": "Text", "enabled": True}]
    return {
        "parts": parts,
        "preview": str(source.get("preview")) if source.get("preview") else None,
        "preview_version": _non_negative_int(source.get("preview_version", 0)),
        "pinned": source.get("pinned") is True,
        "created_at": source.get("created_at") or utc_now(),
        "updated_at": source.get("updated_at") or source.get("created_at") or utc_now(),
        "last_used_at": source.get("last_used_at") or None,
    }


def normalize_library(data: Any, *, strict_keys: bool = True) -> dict[str, dict[str, Any]]:
    if not isinstance(data, dict):
        raise PresetValidationError("Preset library must be an object")
    normalized: dict[str, dict[str, Any]] = {}
    original_names: dict[str, str] = {}
    for raw_key, raw_entry in data.items():
        raw_name = str(raw_key)
        if raw_name.startswith("__"):
            continue
        try:
            key = validate_key(raw_key)
        except PresetValidationError:
            if strict_keys:
                raise
            continue
        if key in normalized:
            raise PresetValidationError(
                f'Preset names collide after normalization: "{original_names[key]}" and "{raw_name}"'
            )
        normalized[key] = normalize_entry(raw_entry, strict=strict_keys)
        original_names[key] = raw_name
    return normalized


def _resolve_preset(
    key: str,
    presets: dict[str, dict[str, Any]],
    stack: tuple[str, ...],
    memo: dict[str, str],
) -> str:
    if key in memo:
        return memo[key]
    if key in stack:
        raise PresetValidationError("Circular composition: " + " -> ".join((*stack, key)))
    entry = presets.get(key)
    if not isinstance(entry, dict):
        raise PresetValidationError(f'Missing preset referenced by composition: "{key}"')

    resolved: list[str] = []
    next_stack = (*stack, key)
    for part in normalize_parts(entry.get("parts")):
        if not part.get("enabled", True):
            continue
        referenced = part.get("key")
        if referenced:
            text = _resolve_preset(referenced, presets, next_stack, memo).strip()
        else:
            text = str(part.get("text", "")).strip()
        if text:
            resolved.append(text)
    memo[key] = "\n\n".join(resolved)
    return memo[key]


def resolve_preset(key: str, presets: dict[str, dict[str, Any]], stack: list[str] | None = None) -> str:
    return _resolve_preset(key, presets, tuple(stack or ()), {})


def validate_library(presets: dict[str, dict[str, Any]]) -> None:
    memo: dict[str, str] = {}
    for key, entry in presets.items():
        for part in normalize_parts(entry.get("parts"), strict=True):
            referenced = part.get("key")
            if referenced and referenced not in presets:
                raise PresetValidationError(f'Missing preset: {referenced}')
        _resolve_preset(key, presets, (), memo)


def build_entry(existing: Any, *, text: str | None = None, parts: Any = None, parts_supplied: bool = False) -> dict[str, Any]:
    current = normalize_entry(existing)
    if parts_supplied:
        normalized_parts = normalize_parts(parts, strict=True)
    elif text is not None:
        if len(text) > MAX_TEXT_LENGTH:
            raise PresetValidationError("Preset text is too large")
        normalized_parts = ([{"text": text, "label": "Text", "enabled": True}]
                            if text.strip() else [])
    else:
        normalized_parts = current["parts"]

    now = utc_now()
    return {
        "parts": normalized_parts,
        "preview": current.get("preview"),
        "preview_version": current.get("preview_version", 0),
        "pinned": current.get("pinned", False),
        "created_at": current.get("created_at") or now,
        "updated_at": now,
        "last_used_at": current.get("last_used_at"),
    }


def save_into_library(
    presets: dict[str, dict[str, Any]],
    raw_key: Any,
    *,
    text: str | None = None,
    parts: Any = None,
    parts_supplied: bool = False,
) -> str:
    key = validate_key(raw_key)
    entry = build_entry(presets.get(key), text=text, parts=parts, parts_supplied=parts_supplied)
    if any(part.get("key") == key for part in entry["parts"]):
        raise PresetValidationError("A composition cannot include itself")
    presets[key] = entry
    return key


def rename_in_library(presets: dict[str, dict[str, Any]], raw_old_key: Any, raw_new_key: Any) -> str:
    old_key = validate_key(raw_old_key)
    new_key = validate_key(raw_new_key)
    if old_key not in presets:
        raise KeyError("Preset not found")
    if new_key != old_key and new_key in presets:
        raise PresetValidationError("A preset with that name already exists")
    if new_key == old_key:
        return old_key

    entry = presets.pop(old_key)
    entry["updated_at"] = utc_now()
    presets[new_key] = entry
    for candidate in presets.values():
        parts = normalize_parts(candidate.get("parts"))
        changed = False
        for part in parts:
            if part.get("key") == old_key:
                part["key"] = new_key
                changed = True
        if changed:
            candidate["parts"] = parts
            candidate["updated_at"] = utc_now()
    return new_key
