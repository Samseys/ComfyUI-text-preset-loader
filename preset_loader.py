import json
import io
from pathlib import Path
from aiohttp import web
from PIL import Image
import server

# pre-define important paths
BASE_DIR     = Path(__file__).resolve().parent
DATA_DIR     = BASE_DIR / "data"
PREVIEWS_DIR = DATA_DIR / "previews"
JSON_PATH    = DATA_DIR / "presets.json"
BROWSE_HTML  = BASE_DIR / "web" / "browse.html"  # standalone mobile editor page

# if for some reason the user deleted the folder and the JSON
DATA_DIR.mkdir(exist_ok=True)
PREVIEWS_DIR.mkdir(exist_ok=True)

if not JSON_PATH.exists():
    starter = {
        "Flux/Styles/oil_painting_aivazovsky": {
            "text": "Oil on canvas painting in the style of Ivan Aivazovsky, characteristic thick brushstrokes and rich texture, deep navy and grey tones with golden highlights.",
            "preview": "Flux_Styles_oil_painting_aivazovsky.jpg", "preview_version": 1
        },
        "Flux/Styles/post_impressionism_vangogh": {
            "text": "Post-impressionism painting in the style of Vincent Van Gogh, swirling expressive brushstrokes, bold impasto texture, vivid contrasting colors.",
            "preview": "Flux_Styles_post_impressionism_vangogh.jpg", "preview_version": 1
        },
        "Flux/Styles/frank_frazetta": {
            "text": "Frank Frazetta fantasy illustration style, bold expressive brushstrokes, vivid dramatic colors.",
            "preview": "Flux_Styles_frank_frazetta.jpg", "preview_version": 1
        },
        "Flux/Styles/edvard_munch_scream": {
            "text": "Oil painting in the style of Edvard Munch's The Scream, expressionist style, muted warm and cold contrast, thick visible brushstrokes.",
            "preview": "Flux_Styles_edvard_munch_scream.jpg", "preview_version": 1
        },
        "Flux/Styles/jack_kirby_comics": {
            "text": "Comic art in the style of Jack Kirby, vibrant bold colors, iconic Kirby krackle energy effects, thick outlines, retro superhero aesthetic, dramatic perspective, flat cel-shaded coloring.",
            "preview": "Flux_Styles_jack_kirby_comics.jpg", "preview_version": 1
        },
        "Flux/Styles/ukiyo_e": {
            "text": "Ukiyo-e woodblock print style, bold black outlines, flat perspective, vibrant traditional colors, dynamic diagonal composition, asymmetrical arrangements, sense of movement and energy, decorative graphic elements, traditional Japanese aesthetic.",
            "preview": "Flux_Styles_ukiyo_e.jpg", "preview_version": 1
        },
        "Flux/Styles/alphonse_mucha_artnouveau": {
            "text": "Alphonse Mucha Art Nouveau style, flowing organic curvilinear lines, muted earthy pastel color palette, subtle watercolor-like textures, ornate decorative elements, intricate fine details, elegant poster composition, natural forms and curves, warm tactile feel.",
            "preview": "Flux_Styles_alphonse_mucha_artnouveau.jpg", "preview_version": 1
        },
    }
    JSON_PATH.write_text(json.dumps(starter, indent=2))

# helper functions

def load_presets() -> dict:
    """
    Read presets.json from disk and return it as a Python dict.
    If the file is missing or corrupted, return an empty dict
    instead of crashing — the node should always be usable.
    """
    try:
        return json.loads(JSON_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_presets(data: dict) -> None:
    """
    Write the presets dict back to presets.json.
    indent=2 keeps it human-readable so users can hand-edit it if they want.
    ensure_ascii=False preserves non-latin characters (Japanese tags, etc.)
    """
    JSON_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )


def preset_key_to_filename(key: str) -> str:
    """
    Convert a preset path like "Styles/lighting/golden_hour"
    into a safe filename like "Styles_lighting_golden_hour.jpg"
    We replace "/" with "_" because slashes are not valid in filenames.
    """
    return key.replace("/", "_") + ".jpg"


# API endpoints
routes = server.PromptServer.instance.routes


@routes.get("/preset_loader/list")
async def list_presets(request):
    """
    GET /preset_loader/list
    Returns the full presets.json as JSON.
    The JS calls this on node load to populate the dropdown.
    """
    presets = load_presets()
    return web.json_response(presets)


@routes.post("/preset_loader/save")
async def save_preset(request):
    """
    POST /preset_loader/save
    Saves a preset (new or overwrite).
    The JS sends this when the user confirms in the Save As popup.

    Expected request body (JSON):
    { "key": "Styles/lighting/golden_hour", "text": "warm tones, ..." }
    """
    try:
        body = await request.json()
        key  = body.get("key", "").strip()
        text = body.get("text", "").strip()

        if not key:
            return web.json_response({"status": "error", "message": "Preset name cannot be empty"})

        presets  = load_presets()
        existing = presets.get(key, {})

        presets[key] = {
            "text":            text,
            "preview":         existing.get("preview", None),
            "preview_version": existing.get("preview_version", 0),
        }

        save_presets(presets)
        return web.json_response({"status": "ok"})

    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/delete")
async def delete_preset(request):
    """
    POST /preset_loader/delete
    Deletes a preset and its preview image (if one exists).

    Expected request body (JSON):
    { "key": "Styles/lighting/golden_hour" }
    """
    try:
        body = await request.json()
        key  = body.get("key", "").strip()

        if not key:
            return web.json_response({"status": "error", "message": "No preset key provided"})

        presets = load_presets()

        if key not in presets:
            return web.json_response({"status": "error", "message": "Preset not found"})

        # Delete the preview image from disk if it exists
        preview_filename = presets[key].get("preview")
        if preview_filename:
            preview_path = PREVIEWS_DIR / preview_filename
            if preview_path.exists():
                preview_path.unlink()

        del presets[key]
        save_presets(presets)

        return web.json_response({"status": "ok"})

    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/set_preview")
async def set_preview(request):
    """
    POST /preset_loader/set_preview
    Saves an image file as the preview for a preset.
    The JS sends this when the user picks an image via the file picker.

    The request is multipart/form-data:
    - "key"  → the preset path string
    - "file" → the image file bytes
    """
    try:
        reader   = await request.multipart()
        key      = None
        img_data = None

        async for part in reader:
            if part.name == "key":
                key = (await part.read()).decode("utf-8").strip()
            elif part.name == "file":
                img_data = await part.read()

        if not key or not img_data:
            return web.json_response({"status": "error", "message": "Missing key or file"})

        presets = load_presets()
        if key not in presets:
            return web.json_response({"status": "error", "message": "Preset not found"})

        # Validate and resize with Pillow.
        # verify() does a deep integrity check — raises if not a valid image.
        # We reopen after verify() because verify() closes the file handle.
        try:
            image = Image.open(io.BytesIO(img_data))
            image.verify()
            image = Image.open(io.BytesIO(img_data))
        except Exception:
            return web.json_response({"status": "error", "message": "File is not a valid image"})

        # Normalize to RGB (handles RGBA, palette, greyscale, etc.)
        # thumbnail() resizes down preserving aspect ratio, never upscales.
        # LANCZOS = best quality downscaling algorithm.
        # We target 1 megapixel (1,000,000 pixels) max.
        # thumbnail() takes a bounding box — we use 1000x1000 which gives
        # exactly 1MP for square images and proportionally less for others.
        image = image.convert("RGB")
        image.thumbnail((1000, 1000), Image.LANCZOS)

        # Save as JPEG — much smaller than PNG for photos
        filename     = preset_key_to_filename(key)
        preview_path = PREVIEWS_DIR / filename
        image.save(preview_path, format="JPEG", quality=85, optimize=True)

        # Increment preview_version so the browser busts its cache
        current_version             = presets[key].get("preview_version", 0)
        presets[key]["preview"]         = filename
        presets[key]["preview_version"] = current_version + 1
        save_presets(presets)

        return web.json_response({
            "status":          "ok",
            "filename":        filename,
            "preview_version": presets[key]["preview_version"]
        })

    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/clear_preview")
async def clear_preview(request):
    """
    POST /preset_loader/clear_preview
    Removes a preset's preview image: deletes the file from disk and clears the
    `preview`/`preview_version` fields. The JS calls this from the "clear" button.

    Expected request body (JSON):
    { "key": "Styles/lighting/golden_hour" }
    """
    try:
        body = await request.json()
        key  = body.get("key", "").strip()

        if not key:
            return web.json_response({"status": "error", "message": "No preset key provided"})

        presets = load_presets()
        if key not in presets:
            return web.json_response({"status": "error", "message": "Preset not found"})

        # Delete the preview file from disk if it exists
        preview_filename = presets[key].get("preview")
        if preview_filename:
            preview_path = PREVIEWS_DIR / preview_filename
            if preview_path.exists():
                preview_path.unlink()

        # Bump the version so any cached <img> stops pointing at the old file
        current_version                 = presets[key].get("preview_version", 0)
        presets[key]["preview"]         = None
        presets[key]["preview_version"] = current_version + 1
        save_presets(presets)

        return web.json_response({"status": "ok"})

    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.get("/preset_loader/preview/{filename}")
async def serve_preview(request):
    """
    GET /preset_loader/preview/{filename}
    Serves a preview image file to the JS.
    Returns 404 if the file doesn't exist.
    """
    filename     = request.match_info["filename"]
    preview_path = PREVIEWS_DIR / filename

    # Security check — prevent path traversal attacks
    if not str(preview_path.resolve()).startswith(str(PREVIEWS_DIR.resolve())):
        return web.Response(status=403)

    if not preview_path.exists():
        return web.Response(status=404)

    return web.FileResponse(preview_path)


@routes.get("/preset_loader/browse")
async def browse_presets(request):
    """
    GET /preset_loader/browse
    Serves the standalone, mobile-friendly editor page (web/browse.html). Open
    this in a phone browser to edit a preset's text and save it, create new
    presets, delete presets, or copy text to paste into the node's text box in
    the mobile frontend. The page reuses the /preset_loader/list, /save, and
    /delete endpoints. Served from disk each request, so edits to browse.html
    take effect on reload without restarting ComfyUI.
    """
    if not BROWSE_HTML.exists():
        return web.Response(status=404, text="browse.html not found")
    return web.FileResponse(BROWSE_HTML)


# NODE CLASS

class PresetLoaderNode:

    # Sentinel for "no preset selected" — kept as a constant so the JS and the
    # backend agree on the exact string.
    NONE_CHOICE = "(none)"

    @classmethod
    def INPUT_TYPES(cls):
        # Build the dropdown choices from presets.json at object_info time.
        # Declaring `preset` as a real widget (instead of a JS-only DOM widget)
        # is what lets ANY frontend render the selector natively — including the
        # experimental mobile frontend, which never runs our JS. Frontends re-fetch
        # /object_info on reload, so newly saved presets appear after a refresh.
        preset_choices = [cls.NONE_CHOICE] + list(load_presets().keys())
        # NOTE: widget order matters. ComfyUI serializes widget values as a
        # POSITIONAL array (widgets_values) with no keys, and restores them by
        # position on load. `text` MUST stay first so workflows saved before the
        # `preset` widget existed keep mapping their text to position 0. New
        # widgets always go at the END to preserve backward compatibility.
        return {
            "required": {
                "text": ("STRING", {
                    "multiline":   True,
                    "default":     "",
                    "placeholder": "Load a preset or type freely...",
                }),
                "preset": (preset_choices, {
                    "default": cls.NONE_CHOICE,
                    "tooltip": "Pick a preset. Used only when the text box is empty — anything typed in the text box overrides it.",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION     = "execute"
    CATEGORY     = "utils/presets"

    def execute(self, preset=None, text="", unique_id=None):
        # Priority: the text box wins. If you typed anything, that overrides the
        # preset. Only when the text box is empty do we fall back to the selected
        # preset's text. This makes the node usable on frontends that never run
        # our JS (e.g. the mobile frontend): pick a preset and leave the box empty
        # to use it as-is, or type in the box to override it.
        #
        # On desktop the DOM UI copies the chosen preset into the (editable) text
        # box, so `text` is non-empty there and is used unchanged — behavior is
        # identical to before.
        if text and text.strip():
            return (text,)
        if preset and preset != self.NONE_CHOICE:
            entry = load_presets().get(preset)
            if entry and entry.get("text"):
                return (entry["text"],)
        return (text,)