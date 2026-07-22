"""Preview image storage: upload parsing, normalisation, and safe filenames.

Previews are the only user-supplied *binary* data this plugin accepts, so all
of the untrusted-input handling lives here rather than among the routes:

* filenames are opaque UUIDs, never derived from a preset name, so renaming a
  preset cannot move or clobber an image and a crafted name cannot escape the
  previews directory;
* uploads are bounded twice — by byte count while streaming and by pixel count
  before decoding — because a small file can still decode to a huge bitmap;
* decoding happens into a temporary file that the caller promotes with an
  atomic replace, so a failed write never leaves a half-written preview.

Pillow work is CPU-bound and must be run off the event loop by the caller
(``asyncio.to_thread``).
"""

from __future__ import annotations

import io
import logging
import os
import tempfile
import uuid
import warnings
from pathlib import Path

from aiohttp import web
from PIL import Image, UnidentifiedImageError

from .preset_model import validate_key
from .preset_storage import PREVIEWS_DIR

LOGGER = logging.getLogger("comfyui.text_preset_loader")

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_PREVIEW_EDGE = 1000
MAX_FILENAME_LENGTH = 128


class PreviewError(ValueError):
    """A rejected preview upload, carrying the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def preview_path(filename: str | None) -> Path | None:
    """Resolve a stored preview name to a path, or None if it is not one of ours.

    Deliberately stricter than "does it escape the directory": only the exact
    shape this module writes is accepted, so a name that arrives from disk or
    from a URL cannot select an arbitrary file even if the JSON was edited.
    """
    if not filename or len(filename) > MAX_FILENAME_LENGTH:
        return None
    if not filename.casefold().endswith(".jpg"):
        return None
    if any(not (char.isalnum() or char in "._-") for char in filename):
        return None
    candidate = (PREVIEWS_DIR / filename).resolve()
    try:
        candidate.relative_to(PREVIEWS_DIR.resolve())
    except ValueError:
        return None
    return candidate


def new_preview_filename() -> str:
    return f"{uuid.uuid4().hex}.jpg"


def process_image_to_temp(image_bytes: bytes) -> Path:
    """Decode, downscale and re-encode an upload into a temporary JPEG.

    Returns the temporary path; the caller owns it and must either os.replace()
    it into place or unlink it. The image is opened twice on purpose: verify()
    consumes the file object, so a second open is required to actually read
    pixels. Dimensions are checked before each open because verify() alone does
    not bound decode cost.
    """
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".preview-", suffix=".jpg.tmp", dir=str(PREVIEWS_DIR)
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        with warnings.catch_warnings():
            # Turn Pillow's decompression-bomb warning into a hard failure.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as source:
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise PreviewError("Image dimensions are too large", 413)
                source.verify()

            with Image.open(io.BytesIO(image_bytes)) as source:
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise PreviewError("Image dimensions are too large", 413)
                source.seek(0)
                source.load()
                # convert("RGB") flattens RGBA/palette/greyscale so JPEG can hold it.
                with source.convert("RGB") as image:
                    image.thumbnail(
                        (MAX_PREVIEW_EDGE, MAX_PREVIEW_EDGE),
                        getattr(Image, "Resampling", Image).LANCZOS,
                    )
                    image.save(temporary_path, format="JPEG", quality=85, optimize=True)
        return temporary_path
    except PreviewError:
        temporary_path.unlink(missing_ok=True)
        raise
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        temporary_path.unlink(missing_ok=True)
        raise PreviewError("File is not a supported image") from exc
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


async def read_preview_upload(request: web.Request) -> tuple[str, bytes]:
    """Stream a multipart preview upload, enforcing the size cap as it arrives.

    The body is read in chunks and abandoned the moment it exceeds the cap, so
    an oversized upload is never fully buffered. Duplicate fields are rejected
    rather than last-one-wins, which would let a second field override a name
    that was already validated.
    """
    if request.content_length is not None and request.content_length > MAX_UPLOAD_BYTES + 64 * 1024:
        raise PreviewError("Preview image is too large", 413)
    try:
        reader = await request.multipart()
    except (AssertionError, ValueError, web.HTTPException) as exc:
        raise PreviewError("Expected multipart form data") from exc

    key: str | None = None
    image_data: bytearray | None = None
    total = 0
    async for part in reader:
        if part.name not in {"key", "file"}:
            raise PreviewError("Unexpected multipart field")
        if part.name == "key" and key is not None:
            raise PreviewError("Preset name was supplied more than once")
        if part.name == "file" and image_data is not None:
            raise PreviewError("Preview file was supplied more than once")

        field_data = bytearray()
        while True:
            chunk = await part.read_chunk(size=64 * 1024)
            if not chunk:
                break
            field_data.extend(chunk)
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise PreviewError("Preview image is too large", 413)
            if part.name == "key" and len(field_data) > 1024:
                raise PreviewError("Preset name is too large", 413)

        if part.name == "key":
            try:
                key = field_data.decode("utf-8").strip()
            except UnicodeDecodeError as exc:
                raise PreviewError("Preset name must be UTF-8") from exc
        else:
            image_data = field_data

    if not key or not image_data:
        raise PreviewError("Missing preset name or image file")
    return validate_key(key), bytes(image_data)


def delete_preview_file(filename: str | None) -> None:
    """Best-effort removal of an orphaned preview; never fails the caller."""
    path = preview_path(filename)
    if path:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            LOGGER.warning("Could not remove orphaned preview %s", path, exc_info=True)
