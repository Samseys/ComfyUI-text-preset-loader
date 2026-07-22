# ComfyUI text preset loader

A ComfyUI custom node for organizing, composing, and reusing text prompts with optional preview images.

## Features

- Hierarchical preset names using `/` as the category separator
- Full-page responsive library at `/preset_loader/browse`
- Search, category navigation, pinned presets, and recent presets
- Reusable `Parts/` presets and composition editing
- Live synchronization between the browser library and open canvas nodes
- Optional normalized JPEG previews
- Atomic, versioned persistence with a last-known-good backup

## Installation

Install the custom node through ComfyUI Manager or clone it into `ComfyUI/custom_nodes`, then install the dependency from `requirements.txt` and restart ComfyUI.

## Usage

Add **Preset Loader** from `utils/presets`. Select a prompt from the node picker; the resolved prompt appears in the read-only text area and is returned from the node. Use **Edit** to change the selected preset, **Duplicate** to create a copy, and the actions menu to manage reusable parts, pin items, delete items, or open the full library.

Open the browser library at:

```text
http://localhost:8188/preset_loader/browse
```

Replace the host or port when ComfyUI is running elsewhere.

Preset names use `/` as a category separator:

```text
Characters/Heroes/example
Camera/Portrait/close_up
Parts/Camera/close_up
```

Names are validated across operating systems. Empty path segments, traversal segments, control characters, backslashes, and reserved filesystem names are rejected.

## Preset composition

A preset can contain ordered text blocks and references to other presets. Parts can be reordered, disabled, or removed. Circular references and missing references are rejected before saving.

Entries under `Parts/` are treated as reusable building blocks and are hidden from the main prompt picker. Renaming a referenced preset updates its references atomically. A referenced preset cannot be deleted until it is removed from its compositions.

## Storage and recovery

Mutable data is stored under the active ComfyUI user directory in:

```text
text-preset-loader/
├── presets.json
├── presets.backup.json
├── usage.json
└── previews/
```

The bundled `data/` directory is used only to seed a new user library. Existing installations are migrated automatically. Legacy preview filenames are copied to unique opaque filenames during migration.

Preset updates use atomic file replacement and retain the previous valid library as a backup. When `presets.json` is unreadable or invalid, the plugin can display the last known-good data but refuses further mutations until the primary file is repaired or restored.

## Preview limits

Preview uploads are bounded to 8 MB and 20 megapixels. Processing runs outside the server event loop, converts images to RGB JPEG, and limits the longest edge to 1000 pixels. Preview URLs use immutable cache headers and a version value for updates.

## Workflow use

Connect the node output directly to a text input or combine it with additional text before sending it to a CLIP text encode node.

## Examples

### Default ComfyUI workflow

![Default usage](workflow/Default-usage_00001_.jpg)

### LoRA tag loader workflow

Uses [comfyui_lora_tag_loader](https://github.com/badjeff/comfyui_lora_tag_loader).

![Load LoRA usage](workflow/LoadLoRA-usage_00001_.jpg)
