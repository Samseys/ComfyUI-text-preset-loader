"""HTTP routes and the ComfyUI node.

Everything the browser talks to lives here; the layers underneath
(preset_model, preset_storage, preset_previews) know nothing about aiohttp.

Two conventions run through the handlers:

* mutations take ``_write_lock`` and then read with ``strict=True``, so a
  request never bases a write on a library that failed validation, and two
  concurrent requests cannot interleave read-modify-write;
* successful mutations call publish_change(), which pushes an invalidation over
  SSE. Clients re-fetch rather than receiving the change itself, so an open
  canvas node and a phone on the browse page converge on the same state without
  either becoming a replication target.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
from copy import deepcopy
from functools import wraps
from pathlib import Path
from typing import Any

from aiohttp import web

from .preset_model import (
    PresetValidationError,
    normalize_parts,
    rename_in_library,
    resolve_preset,
    save_into_library,
    utc_now,
    validate_key,
    validate_library,
)
from .preset_previews import (
    PreviewError,
    delete_preview_file,
    new_preview_filename,
    preview_path,
    process_image_to_temp,
    read_preview_upload,
)
from .preset_storage import (
    BASE_DIR,
    PREVIEWS_DIR,
    PresetStorageError,
    presets_with_usage,
    read_presets,
    read_usage,
    storage_warning,
    write_presets,
    write_usage,
)

LOGGER = logging.getLogger("comfyui.text_preset_loader")
WEB_DIR = BASE_DIR / "web"
BROWSE_HTML = WEB_DIR / "browse.html"
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_BATCH_EDITS = 256
USAGE_FLUSH_DELAY_SECONDS = 0.5

_write_lock = asyncio.Lock()
_usage_lock = asyncio.Lock()
_subscribers: set[asyncio.Queue] = set()
_revision = 0
_pending_usage: dict[str, str] = {}
_usage_flush_task: asyncio.Task | None = None
_resolved_snapshot: dict[str, dict[str, Any]] | None = None
_resolved_outputs: dict[str, str] = {}


class RequestError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def json_error(message: str, status: int) -> web.Response:
    return web.json_response({"status": "error", "message": message}, status=status)


def route_guard(handler):
    """Translate exceptions into HTTP responses.

    Handlers raise domain errors and stay free of status codes; the mapping to
    status lives here so it is consistent across every route. CancelledError is
    re-raised deliberately — swallowing it would break aiohttp's shutdown — and
    the catch-all logs the traceback but answers with a generic message, since
    the text reaches a browser.
    """
    @wraps(handler)
    async def wrapped(request):
        try:
            return await handler(request)
        except (RequestError, PreviewError) as exc:
            # Both carry the status they should be answered with.
            return json_error(str(exc), exc.status)
        except PresetValidationError as exc:
            return json_error(str(exc), 400)
        except KeyError as exc:
            return json_error(str(exc.args[0] if exc.args else "Not found"), 404)
        except PresetStorageError as exc:
            LOGGER.error("Preset storage operation refused for %s %s: %s", request.method, request.path, exc)
            return json_error(
                "Preset storage is unavailable or invalid; check the ComfyUI log and restore presets.json.",
                409,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("Unhandled preset-loader request failure for %s %s", request.method, request.path)
            return json_error("The preset operation could not be completed", 500)

    return wrapped


async def read_json_body(request: web.Request) -> dict[str, Any]:
    """Read and parse a JSON request body under a hard size cap.

    Content-Length is checked first as a cheap rejection, but it is client-
    supplied and may be absent or lie, so the streamed read enforces the same
    limit again and aborts mid-body rather than buffering the whole thing.
    """
    if request.content_type != "application/json":
        raise RequestError("Content-Type must be application/json", 415)
    if request.content_length is not None and request.content_length > MAX_JSON_BYTES:
        raise RequestError("Request body is too large", 413)
    payload = bytearray()
    async for chunk in request.content.iter_chunked(64 * 1024):
        payload.extend(chunk)
        if len(payload) > MAX_JSON_BYTES:
            raise RequestError("Request body is too large", 413)
    try:
        body = json.loads(payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise RequestError("Request body must be valid JSON") from exc
    if not isinstance(body, dict):
        raise RequestError("Request body must be a JSON object")
    return body


def publish_change(action: str, key: str | None = None, *, content_changed: bool = True) -> None:
    """Tell every connected client that the library moved.

    `content_changed=False` marks changes that alter presentation but not any
    resolved prompt (pinning, preview images). A canvas node uses it to skip
    re-resolving text it already has, which matters because re-resolving would
    otherwise clobber a text override the user is mid-edit.

    Each subscriber queue holds one event. When it is full the oldest is dropped
    rather than blocking: the events are invalidation signals, so a slow or
    backgrounded tab only needs the most recent one.
    """
    global _revision
    _revision += 1
    event = {
        "revision": _revision,
        "action": action,
        "key": key,
        "content_changed": content_changed,
    }
    for queue in tuple(_subscribers):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass


async def _flush_pending_usage() -> None:
    """Write buffered last-used timestamps once, after a short delay.

    Selecting presets in quick succession would otherwise mean a file write per
    click. Touches accumulate in memory and land in one write; entries for
    presets that no longer exist are dropped on the way, which is what keeps
    usage.json from growing stale keys forever.
    """
    global _usage_flush_task
    await asyncio.sleep(USAGE_FLUSH_DELAY_SECONDS)
    async with _usage_lock:
        updates = dict(_pending_usage)
        _pending_usage.clear()
        if not updates:
            _usage_flush_task = None
            return
        try:
            presets = await asyncio.to_thread(read_presets)
            usage = await asyncio.to_thread(read_usage, copy_data=True)
            usage = {name: value for name, value in usage.items() if name in presets}
            usage.update({name: value for name, value in updates.items() if name in presets})
            await asyncio.to_thread(write_usage, usage)
        except Exception:
            # Recent-use metadata is non-critical. Keep the newest values in memory
            # and retry on the next touch instead of affecting prompt operations.
            _pending_usage.update(updates)
            LOGGER.warning("Could not persist preset usage metadata", exc_info=True)
        finally:
            _usage_flush_task = None


def _schedule_usage_flush() -> None:
    global _usage_flush_task
    if _usage_flush_task is None or _usage_flush_task.done():
        _usage_flush_task = asyncio.create_task(_flush_pending_usage())


async def _move_usage_metadata(old_key: str, new_key: str) -> None:
    async with _usage_lock:
        if old_key in _pending_usage:
            _pending_usage[new_key] = _pending_usage.pop(old_key)
        usage = await asyncio.to_thread(read_usage, copy_data=True)
        if old_key in usage:
            usage[new_key] = usage.pop(old_key)
            try:
                await asyncio.to_thread(write_usage, usage)
            except OSError:
                LOGGER.warning("Could not update usage metadata after rename", exc_info=True)


_ROUTES: list[tuple[str, str, Any]] = []


def route(method: str, path: str):
    """Collect a handler for later binding by register_routes().

    Deferred rather than bound at import time so this module can be imported
    without a live ``server.PromptServer.instance`` — which is what keeps the
    route, storage and model layers loadable outside a running ComfyUI.
    """
    def decorate(handler):
        _ROUTES.append((method, path, handler))
        return handler
    return decorate


def register_routes(routes=None) -> None:
    """Bind every collected handler onto ComfyUI's route table."""
    if routes is None:
        import server

        routes = server.PromptServer.instance.routes
    for method, path, handler in _ROUTES:
        routes.route(method, path)(handler)


@route("GET", "/preset_loader/list")
@route_guard
async def list_presets(request):
    presets = await asyncio.to_thread(presets_with_usage)
    async with _usage_lock:
        pending_usage = dict(_pending_usage)
    for key, used_at in pending_usage.items():
        if key in presets:
            presets[key]["last_used_at"] = used_at
    headers = {"Cache-Control": "no-store"}
    warning = storage_warning()
    if warning:
        headers["X-Preset-Loader-Warning"] = "storage-invalid"
    return web.json_response(presets, headers=headers)


@route("GET", "/preset_loader/events")
async def preset_events(request):
    response = web.StreamResponse(headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })
    await response.prepare(request)
    queue: asyncio.Queue = asyncio.Queue(maxsize=1)
    _subscribers.add(queue)
    try:
        ready = json.dumps({"revision": _revision})
        await response.write(f"event: ready\ndata: {ready}\n\n".encode("utf-8"))
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=20)
                payload = json.dumps(event, ensure_ascii=False)
                await response.write(
                    f"event: presets-changed\ndata: {payload}\n\n".encode("utf-8")
                )
            except asyncio.TimeoutError:
                await response.write(b": keepalive\n\n")
    except asyncio.CancelledError:
        raise
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        _subscribers.discard(queue)
    return response


@route("POST", "/preset_loader/save")
@route_guard
async def save_preset(request):
    body = await read_json_body(request)
    async with _write_lock:
        presets = await asyncio.to_thread(read_presets, strict=True, copy_data=True)
        text_supplied = "text" in body
        key = save_into_library(
            presets,
            body.get("key"),
            text=str(body.get("text", "")) if text_supplied else None,
            parts=body.get("parts"),
            parts_supplied="parts" in body,
        )
        validate_library(presets)
        await asyncio.to_thread(write_presets, presets)
    publish_change("save", key)
    return web.json_response({"status": "ok", "key": key})


@route("POST", "/preset_loader/batch")
@route_guard
async def batch_update_presets(request):
    """Commit an editor session as one transaction.

    Saving a composition can touch several presets at once: inline edits to the
    parts it references, a rename of the preset itself, and its own new content.
    Doing that as separate requests would leave the library briefly inconsistent
    — and a failure halfway through would strand it there. Everything is applied
    to one in-memory copy, validated, and written once.

    Order matters: referenced parts are saved first so the rename can rewrite
    references, and the target preset is written last.
    """
    body = await read_json_body(request)
    edited = body.get("edited", [])
    if not isinstance(edited, list):
        raise RequestError("Edited presets must be a list")
    if len(edited) > MAX_BATCH_EDITS:
        raise RequestError(f"A batch cannot edit more than {MAX_BATCH_EDITS} presets")

    renamed_from: str | None = None
    async with _write_lock:
        presets = await asyncio.to_thread(read_presets, strict=True, copy_data=True)
        for item in edited:
            if not isinstance(item, dict):
                raise RequestError("Each edited preset must be an object")
            save_into_library(
                presets,
                item.get("key"),
                parts=item.get("parts"),
                parts_supplied=True,
            )

        current_key = body.get("current_key")
        target_key = validate_key(body.get("key"))
        if current_key:
            current_key = validate_key(current_key)
            if current_key != target_key:
                renamed_from = current_key
                rename_in_library(presets, current_key, target_key)

        save_into_library(
            presets,
            target_key,
            parts=body.get("parts"),
            parts_supplied=True,
        )
        validate_library(presets)
        await asyncio.to_thread(write_presets, presets)

    if renamed_from:
        await _move_usage_metadata(renamed_from, target_key)
    publish_change("batch", target_key)
    return web.json_response({"status": "ok", "key": target_key})


@route("POST", "/preset_loader/rename")
@route_guard
async def rename_preset(request):
    body = await read_json_body(request)
    old_key = validate_key(body.get("old_key"))
    async with _write_lock:
        presets = await asyncio.to_thread(read_presets, strict=True, copy_data=True)
        new_key = rename_in_library(presets, old_key, body.get("new_key"))
        validate_library(presets)
        await asyncio.to_thread(write_presets, presets)

    if old_key != new_key:
        await _move_usage_metadata(old_key, new_key)
    publish_change("rename", new_key)
    return web.json_response({"status": "ok", "key": new_key})


@route("POST", "/preset_loader/duplicate")
@route_guard
async def duplicate_preset(request):
    body = await read_json_body(request)
    source_key = validate_key(body.get("source_key"))
    new_key = validate_key(body.get("new_key"))
    copied_preview: Path | None = None

    async with _write_lock:
        presets = await asyncio.to_thread(read_presets, strict=True, copy_data=True)
        if source_key not in presets:
            raise KeyError("Source preset not found")
        if new_key in presets:
            raise PresetValidationError("A preset with that name already exists")

        entry = deepcopy(presets[source_key])
        source_preview = preview_path(entry.get("preview"))
        if source_preview and source_preview.exists():
            filename = new_preview_filename()
            copied_preview = PREVIEWS_DIR / filename
            await asyncio.to_thread(shutil.copy2, source_preview, copied_preview)
            entry["preview"] = filename
            entry["preview_version"] = int(entry.get("preview_version", 0) or 0) + 1

        now = utc_now()
        entry["pinned"] = False
        entry["created_at"] = now
        entry["updated_at"] = now
        entry["last_used_at"] = None
        presets[new_key] = entry
        try:
            validate_library(presets)
            await asyncio.to_thread(write_presets, presets)
        except Exception:
            if copied_preview:
                copied_preview.unlink(missing_ok=True)
            raise

    publish_change("duplicate", new_key)
    return web.json_response({"status": "ok", "key": new_key})


@route("POST", "/preset_loader/pin")
@route_guard
async def pin_preset(request):
    body = await read_json_body(request)
    key = validate_key(body.get("key"))
    pinned = body.get("pinned", True) is True
    async with _write_lock:
        presets = await asyncio.to_thread(read_presets, strict=True, copy_data=True)
        if key not in presets:
            raise KeyError("Preset not found")
        presets[key]["pinned"] = pinned
        presets[key]["updated_at"] = utc_now()
        await asyncio.to_thread(write_presets, presets)
    publish_change("pin", key, content_changed=False)
    return web.json_response({"status": "ok", "pinned": pinned})


@route("POST", "/preset_loader/touch")
@route_guard
async def touch_preset(request):
    body = await read_json_body(request)
    key = validate_key(body.get("key"))
    presets = await asyncio.to_thread(read_presets)
    if key not in presets:
        raise KeyError("Preset not found")
    async with _usage_lock:
        _pending_usage[key] = utc_now()
        _schedule_usage_flush()
    return web.json_response({"status": "ok"})


@route("POST", "/preset_loader/delete")
@route_guard
async def delete_preset(request):
    body = await read_json_body(request)
    key = validate_key(body.get("key"))
    preview_filename: str | None = None
    async with _write_lock:
        presets = await asyncio.to_thread(read_presets, strict=True, copy_data=True)
        if key not in presets:
            raise KeyError("Preset not found")
        used_by = [
            name for name, entry in presets.items()
            if any(part.get("key") == key for part in normalize_parts(entry.get("parts")))
        ]
        if used_by:
            raise PresetValidationError(f'Preset is used by composition: {used_by[0]}')
        preview_filename = presets[key].get("preview")
        del presets[key]
        await asyncio.to_thread(write_presets, presets)

    async with _usage_lock:
        _pending_usage.pop(key, None)
        usage = await asyncio.to_thread(read_usage, copy_data=True)
        if usage.pop(key, None) is not None:
            try:
                await asyncio.to_thread(write_usage, usage)
            except OSError:
                LOGGER.warning("Could not remove usage metadata after deletion", exc_info=True)
    await asyncio.to_thread(delete_preview_file, preview_filename)
    publish_change("delete", key)
    return web.json_response({"status": "ok"})


@route("POST", "/preset_loader/set_preview")
@route_guard
async def set_preview(request):
    key, image_bytes = await read_preview_upload(request)
    presets_snapshot = await asyncio.to_thread(read_presets)
    if key not in presets_snapshot:
        raise KeyError("Preset not found")

    temporary_path = await asyncio.to_thread(process_image_to_temp, image_bytes)
    final_filename = new_preview_filename()
    final_path = PREVIEWS_DIR / final_filename
    old_filename: str | None = None
    version = 0
    try:
        async with _write_lock:
            presets = await asyncio.to_thread(read_presets, strict=True, copy_data=True)
            if key not in presets:
                raise KeyError("Preset not found")
            old_filename = presets[key].get("preview")
            await asyncio.to_thread(os.replace, temporary_path, final_path)
            version = int(presets[key].get("preview_version", 0) or 0) + 1
            presets[key]["preview"] = final_filename
            presets[key]["preview_version"] = version
            presets[key]["updated_at"] = utc_now()
            try:
                await asyncio.to_thread(write_presets, presets)
            except Exception:
                final_path.unlink(missing_ok=True)
                raise
    finally:
        temporary_path.unlink(missing_ok=True)

    if old_filename and old_filename != final_filename:
        await asyncio.to_thread(delete_preview_file, old_filename)
    publish_change("preview", key, content_changed=False)
    return web.json_response({
        "status": "ok",
        "filename": final_filename,
        "preview_version": version,
    })


@route("POST", "/preset_loader/clear_preview")
@route_guard
async def clear_preview(request):
    body = await read_json_body(request)
    key = validate_key(body.get("key"))
    old_filename: str | None = None
    async with _write_lock:
        presets = await asyncio.to_thread(read_presets, strict=True, copy_data=True)
        if key not in presets:
            raise KeyError("Preset not found")
        old_filename = presets[key].get("preview")
        presets[key]["preview"] = None
        presets[key]["preview_version"] = int(presets[key].get("preview_version", 0) or 0) + 1
        presets[key]["updated_at"] = utc_now()
        await asyncio.to_thread(write_presets, presets)
    await asyncio.to_thread(delete_preview_file, old_filename)
    publish_change("preview", key, content_changed=False)
    return web.json_response({"status": "ok"})


@route("GET", "/preset_loader/preview/{filename}")
async def serve_preview(request):
    path = preview_path(request.match_info["filename"])
    if path is None:
        return web.Response(status=403)
    if not path.is_file():
        return web.Response(status=404)
    return web.FileResponse(
        path,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )


@route("GET", "/preset_loader/assets/{filename:.+}")
async def serve_asset(request):
    """Serve JS/CSS from web/, including subdirectories.

    `filename` is attacker-controlled: it comes straight off the URL and may
    contain `..` segments, an encoded traversal, or an absolute path, and a
    join with WEB_DIR does not defend against any of that (an absolute
    right-hand side even replaces the join outright). Containment is checked
    against the *resolved* candidate path rather than the raw string because
    resolution is also what collapses `..` and follows symlinks — a string
    check has no way to know a symlink inside web/ leads outside it, but a
    resolved-path comparison does. Anything that fails any check answers 404,
    the same as a genuinely missing file, so the route never confirms what
    exists on disk.
    """
    filename = request.match_info["filename"]
    if Path(filename).suffix.lower() not in (".js", ".css"):
        return web.Response(status=404)
    web_dir = WEB_DIR.resolve()
    candidate = (WEB_DIR / filename).resolve()
    try:
        candidate.relative_to(web_dir)
    except ValueError:
        return web.Response(status=404)
    if not candidate.is_file():
        return web.Response(status=404)
    return web.FileResponse(candidate, headers={
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
    })


@route("GET", "/preset_loader/browse")
async def browse_presets(request):
    if not BROWSE_HTML.is_file():
        return web.Response(status=404, text="browse.html not found")
    return web.FileResponse(BROWSE_HTML, headers={
        "Cache-Control": "no-cache",
        "Content-Security-Policy": (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'self'"
        ),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    })


class PresetLoaderNode:
    # Sentinel for "no preset selected". Shared with the JS, which must send the
    # exact same string, so it lives here rather than being written twice.
    NONE_CHOICE = "(none)"

    @classmethod
    def INPUT_TYPES(cls):
        """Declare the node's widgets.

        `preset` is a real COMBO widget rather than a JS-only DOM widget so that
        frontends which never run web/preset_loader.js — the experimental mobile
        frontend in particular — can still render and use the selector. The
        desktop canvas hides it and drives the richer DOM UI instead.

        Choices are built here, at object_info time, so a frontend picks up newly
        saved presets on reload. Parts/ entries are excluded: they are fragments
        meant for composition, not prompts to select on their own.
        """
        try:
            presets = read_presets()
        except PresetStorageError:
            # A broken library must not stop the node from loading; an empty
            # dropdown is recoverable, an exception here is not.
            LOGGER.exception("Could not build preset choices")
            presets = {}
        preset_choices = [cls.NONE_CHOICE] + [
            key for key in presets if not key.startswith("Parts/")
        ]
        # WIDGET ORDER IS LOAD-BEARING. ComfyUI serialises widget values into
        # `widgets_values`, a positional array with no keys, and restores them by
        # position. `text` must stay first so workflows saved before `preset`
        # existed still map their text to index 0. Any new widget goes at the END.
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "placeholder": "Load a preset or type freely...",
                }),
                "preset": (preset_choices, {
                    "default": cls.NONE_CHOICE,
                    "tooltip": (
                        "Pick a preset. Used only when the text box is empty; "
                        "typed text overrides it."
                    ),
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "execute"
    CATEGORY = "utils/presets"

    @classmethod
    def _resolve_output(cls, preset, text):
        """The exact string this node outputs for the given inputs.

        The text box wins: anything typed there overrides the selected preset.
        Only an empty box falls back to resolving the preset, which is what makes
        the node usable on frontends that never run our JS — pick a preset and
        leave the box empty. The desktop DOM UI copies the resolved preset into
        the box, so `text` is non-empty there and is used unchanged.

        Shared by execute() and IS_CHANGED() so the cache fingerprint tracks the
        prompt actually produced, and nothing else.
        """
        global _resolved_snapshot, _resolved_outputs
        if text and text.strip():
            return text
        if preset and preset != cls.NONE_CHOICE:
            try:
                presets = read_presets()
                if preset in presets:
                    # read_presets() hands back the same cached object until the
                    # library changes on disk, so identity is a sound signal that
                    # memoised resolutions are still valid.
                    if presets is not _resolved_snapshot:
                        _resolved_snapshot = presets
                        _resolved_outputs = {}
                    if preset not in _resolved_outputs:
                        _resolved_outputs[preset] = resolve_preset(preset, presets)
                    return _resolved_outputs[preset]
            except (PresetStorageError, PresetValidationError):
                # Fall through to `text` rather than failing the prompt: a broken
                # or missing preset should not take a whole queued run down.
                LOGGER.warning("Could not resolve preset %s", preset, exc_info=True)
        return text

    @classmethod
    def IS_CHANGED(cls, preset=None, text="", unique_id=None):
        """Fingerprint the resolved prompt, not the widget values.

        ComfyUI caches a node's output against its inputs. When a preset is used
        as-is (empty text box) the selected key stays identical even after the
        preset — or any part it composes — is edited elsewhere, so ComfyUI would
        serve a stale result. Hashing the resolved output invalidates the cache
        exactly when the produced prompt changes.
        """
        output = cls._resolve_output(preset, text)
        return hashlib.sha256(output.encode("utf-8")).hexdigest()

    def execute(self, preset=None, text="", unique_id=None):
        return (self._resolve_output(preset, text),)
