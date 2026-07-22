// =============================================================================
// preset_loader.js
// =============================================================================

import { app } from "../../scripts/app.js";
import { presetApi } from "./preset_api.js";
import { loadPresets, subscribePresets } from "./preset_store.js";
import { resolvePreset as resolvePresetText, isComposition, validateKey } from "./preset_model.js";
import { openPresetEditor, openPartCreator } from "./preset_editor.js";
import { openPresetPicker } from "./preset_picker.js";
import { confirmDialog, openPopover, promptDialog } from "./preset_dialog.js";
import { iconSvg, pathTone } from "./preset_icons.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const API_BASE = "/preset_loader";

// ── PREVIEW ──────────────────────────────────────────────────────────────────
const PREVIEW_HEIGHT     = 200;     // default height of the preview image box (px)
const PREVIEW_MIN_HEIGHT = 80;      // smallest the drag handle allows (px)
const PREVIEW_MAX_HEIGHT = 640;     // largest the drag handle allows (px)

// ── NODE SIZE ────────────────────────────────────────────────────────────────
const NODE_MIN_WIDTH  = 300;       // minimum node width in pixels
const NODE_MIN_HEIGHT = 200;       // minimum node height in pixels

// ── COLOURS ──────────────────────────────────────────────────────────────────
// Colours live in preset_ui.css under the .pl-node token block.

// =============================================================================
// POPUP HELPERS
// =============================================================================


// Deletion is irreversible and the server can refuse it (the preset may still be
// referenced by a composition), so the failure has to be readable rather than
// thrown away — confirmDialog keeps the panel open and shows the message.
function showDeletePopup(key, onDeleted) {
    const name = document.createElement("strong");
    name.textContent = `"${key}"`;
    const message = document.createDocumentFragment();
    message.append("Delete ", name, " permanently?");

    return confirmDialog({
        title: "Delete preset",
        message,
        detail: "This cannot be undone.",
        confirmLabel: "Delete",
        onConfirm: async () => {
            await presetApi.remove(key);
            await onDeleted?.();
        },
    });
}

// =============================================================================
// EXTENSION
// =============================================================================

// The node's DOM widgets live in ComfyUI's document, which has no knowledge of
// this plugin's stylesheet. Link it once, on the first node created.
function ensureStyles() {
    const ID = "pl-ui-styles";
    if (document.getElementById(ID)) return;
    const link = document.createElement("link");
    link.id = ID;
    link.rel = "stylesheet";
    link.href = `${API_BASE}/assets/preset_ui.css`;
    document.head.append(link);
}

app.registerExtension({
    name: "presetloader.PresetLoader",

    async nodeCreated(node) {
        if (node.comfyClass !== "PresetLoader") return;
        ensureStyles();

        // ── STATE ────────────────────────────────────────────────────────────
        let presets     = {};
        let selectedKey = null;
        let lastLoadedText = null;

        try {
            presets = await loadPresets();
        } catch (error) {
            console.error("Could not load presets for Preset Loader node", error);
            presets = {};
        }

        // ── MINIMUM NODE SIZE ────────────────────────────────────────────────
        node.minSize = [NODE_MIN_WIDTH, NODE_MIN_HEIGHT];
        const origResize = node.onResize;
        node.onResize = function(size) {
            size[0] = Math.max(size[0], NODE_MIN_WIDTH);
            size[1] = Math.max(size[1], NODE_MIN_HEIGHT);
            origResize?.call(this, size);
        };

        // ── NATIVE PRESET WIDGET (mobile / non-canvas frontends) ─────────────
        // Python declares a real `preset` COMBO so frontends that don't run this
        // JS (e.g. the experimental mobile frontend) can render and use the
        // selector. On the desktop canvas we hide it — the rich DOM dropdown
        // below replaces it — and keep it at "(none)" so the backend uses this
        // node's editable text box instead of the preset.
        const NONE_CHOICE = "(none)";
        const presetWidget = node.widgets.find(w => w.name === "preset");
        const nativePresetValue = presetWidget?.value && presetWidget.value !== NONE_CHOICE
            ? String(presetWidget.value)
            : null;
        if (presetWidget) {
            presetWidget.value = NONE_CHOICE;
            presetWidget.hidden = true;                 // legacy canvas rendering
            presetWidget.options = presetWidget.options || {};
            presetWidget.options.hidden = true;         // Vue "nodes v2" rendering
            presetWidget.computeSize = () => [0, -4];   // collapse its reserved row
        }

        // ── NATIVE TEXT WIDGET ───────────────────────────────────────────────
        const textWidget = node.widgets.find(w => w.name === "text");
        // element is the correct property (inputEl is deprecated)
        const textWidgetEl = textWidget?.element ?? null;
        // The text box is a read-only preview of the resolved prompt. Editing a
        // preset's content happens in the unified editor; the box just shows (and
        // carries, for the output) the composed result of the current selection.
        if (textWidgetEl) {
            textWidgetEl.readOnly = true;
            textWidgetEl.style.cursor = "default";
            textWidgetEl.title = "Resolved prompt (read-only) — use Edit to change it";
        }

        // Helper — reads current text widget colours from the live theme
        function getThemeColors() {
            if (!textWidgetEl) return { bg: "#1e1e2a", color: "#d0cde8" };
            const cs = getComputedStyle(textWidgetEl);
            return { bg: cs.backgroundColor, color: cs.color };
        }

        // ── SINGLE CONTAINER WIDGET ──────────────────────────────────────────
        const uiWidget = node.addDOMWidget("preset_ui", "div", (() => {
            // pl-scope carries the shared tokens; pl-node the canvas styling.
            const root = document.createElement("div");
            root.className = "pl-scope pl-node";

            // ── DROPDOWN ────────────────────────────────────────────────────
            const dropdownEl = document.createElement("div");
            dropdownEl.className = "pl-node__dropdown";

            // The one style that cannot live in CSS: it tracks whatever
            // background ComfyUI's active theme gives the text widget.
            function syncDropdownColor() {
                const { bg } = getThemeColors();
                dropdownEl.style.background = bg;
            }
            syncDropdownColor();

            // Observers are registered after updateLabel is defined — see below

            dropdownEl.innerHTML = `<span data-role="preset-label" class="pl-node__label">— select preset —</span><span class="pl-node__chevron">${iconSvg("down", 14)}</span>`;
            dropdownEl.addEventListener("click", async () => {
                // The shared store is refreshed by one EventSource for the page.
                presets = await loadPresets();
                openPresetPicker({ anchor: dropdownEl, presets, currentKey: selectedKey, mode: "prompts", onSelect: (key) => {
                    selectedKey = key;
                    persistKey();
                    textWidget.value = resolvePresetText(key, presets);
                    lastLoadedText = textWidget.value;
                    updateLabel();
                    updatePreview();
                    node.setDirtyCanvas(true);
                    presetApi.touch(key).catch(() => {});
                }});
            });
            const selectorRow = document.createElement("div");
            selectorRow.className = "pl-node__selector";
            const newBtn = document.createElement("button");
            newBtn.type = "button";
            newBtn.className = "pl-node__new";
            newBtn.innerHTML = iconSvg("plus", 17);
            newBtn.title = "Create a new prompt";
            newBtn.setAttribute("aria-label", "Create new prompt");
            newBtn.onclick = () => openMainEditor(null);
            selectorRow.append(dropdownEl, newBtn);
            root.appendChild(selectorRow);

            // ── PREVIEW AREA ─────────────────────────────────────────────────
            // Hidden by default; updatePreview() shows it when a preset with a
            // preview image is selected AND the per-node "Show preset preview"
            // toggle (right-click menu) is on. A fixed-height image box keeps the
            // widget's computeSize deterministic.
            const previewArea = document.createElement("div");
            previewArea.dataset.role = "preview-area";
            previewArea.className = "pl-node__preview";

            const imgBox = document.createElement("div");
            imgBox.dataset.role = "preview-box";
            imgBox.className = "pl-node__imgbox";
            // Height is inline because the drag handle writes it and it is
            // persisted per node in node.properties.
            imgBox.style.height = `${PREVIEW_HEIGHT}px`;

            const img = document.createElement("img");
            img.dataset.role = "preview-image";
            img.className = "pl-node__img";
            img.alt = "";
            img.style.display = "none";
            imgBox.appendChild(img);

            const noPreview = document.createElement("div");
            noPreview.dataset.role = "preview-empty";
            noPreview.className = "pl-node__empty";
            noPreview.innerHTML = `
                <span class="pl-node__empty-icon">${iconSvg("image", 20)}</span>
                <span>NO PREVIEW</span>
            `;
            imgBox.appendChild(noPreview);

            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = "image/*";
            fileInput.style.display = "none";
            imgBox.appendChild(fileInput);

            const setImgBtn = document.createElement("button");
            setImgBtn.type = "button";
            setImgBtn.className = "pl-node__img-btn pl-node__img-btn--set";
            setImgBtn.textContent = "📁 set image";
            setImgBtn.addEventListener("click", () => {
                if (!selectedKey) { alert("Please select a preset first."); return; }
                fileInput.click();
            });
            fileInput.addEventListener("change", async () => {
                const file = fileInput.files[0];
                if (!file) return;
                try {
                    await presetApi.setPreview(selectedKey, file);
                    presets = await loadPresets({ force: true });
                    updatePreview();
                } catch (error) {
                    alert("Error setting preview: " + error.message);
                } finally {
                    fileInput.value = "";
                }
            });
            imgBox.appendChild(setImgBtn);

            // Clear button — removes the current preset's preview image. Only shown
            // when the selected preset actually has one (toggled in updatePreview).
            const clearImgBtn = document.createElement("button");
            clearImgBtn.type = "button";
            clearImgBtn.dataset.role = "preview-clear";
            clearImgBtn.className = "pl-node__img-btn pl-node__img-btn--clear";
            clearImgBtn.textContent = "🗑 clear";
            clearImgBtn.style.display = "none";
            clearImgBtn.addEventListener("click", async () => {
                if (!selectedKey) return;
                try {
                    await presetApi.clearPreview(selectedKey);
                    presets = await loadPresets({ force: true });
                    updatePreview();
                } catch (error) {
                    alert("Error clearing preview: " + error.message);
                }
            });
            imgBox.appendChild(clearImgBtn);

            // Drag handle — lets the user set the preview box height. The height is
            // persisted in node.properties.previewHeight and reapplied on reload.
            const resizeHandle = document.createElement("div");
            resizeHandle.className = "pl-node__resize";
            resizeHandle.title = "Drag to resize preview";
            resizeHandle.innerHTML = iconSvg("gripHorizontal", 17);
            resizeHandle.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation();           // don't let LiteGraph start dragging the node
                resizeHandle.setPointerCapture?.(e.pointerId);
                const scale     = app.canvas?.ds?.scale || 1;  // overlay is CSS-scaled by zoom
                const startY    = e.clientY;
                const startBoxH = imgBox.offsetHeight;
                const startNodeH = node.size[1];

                const onMove = (ev) => {
                    const delta = (ev.clientY - startY) / scale;
                    const boxH  = Math.max(PREVIEW_MIN_HEIGHT, Math.min(PREVIEW_MAX_HEIGHT, startBoxH + delta));
                    imgBox.style.height = boxH + "px";
                    // Grow/shrink the node by the same amount so the text area above
                    // keeps its size instead of being squeezed.
                    node.setSize([node.size[0], startNodeH + (boxH - startBoxH)]);
                    node.setDirtyCanvas(true, true);
                };
                const onUp = (ev) => {
                    resizeHandle.releasePointerCapture?.(ev.pointerId);
                    resizeHandle.removeEventListener("pointermove", onMove);
                    resizeHandle.removeEventListener("pointerup", onUp);
                    node.properties["previewHeight"] = imgBox.offsetHeight;
                    node.setDirtyCanvas(true, true);
                };
                resizeHandle.addEventListener("pointermove", onMove);
                resizeHandle.addEventListener("pointerup", onUp);
            });
            imgBox.appendChild(resizeHandle);

            previewArea.appendChild(imgBox);
            root.appendChild(previewArea);

            // ── BUTTONS ROW ──────────────────────────────────────────────────
            const btnRow = document.createElement("div");
            btnRow.className = "pl-node__actions";

            /** `variant`: "" | "primary" | "icon". */
            function makeBtn(label, variant = "") {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = `pl-node__btn${variant ? ` pl-node__btn--${variant}` : ""}`;
                btn.textContent = label;
                return btn;
            }

            // Thin transport wrappers over the /preset_loader endpoints, shared
            // by the unified editor. Each throws on a non-ok response so the editor
            // can surface the message.
            const editorApi = {
                ...presetApi,
                list: () => loadPresets({ force: true }),
            };

            // Adding a reference part browses existing presets under Parts/, with a
            // "+ New" that creates a reusable part and drops it straight into the
            // composition — the same view (and capability) as "Manage parts".
            const partPicker = (anchor, onPick) => openPresetPicker({
                anchor, presets, mode: "parts", onSelect: onPick,
                createAction: { label: "+ New", run: () => openPartCreator({
                    presets, api: editorApi,
                    onCreated: async (key) => {
                        presets = await loadPresets({ force: true });
                        if (selectedKey && presets[selectedKey]) { lastLoadedText = resolvePresetText(selectedKey, presets); textWidget.value = lastLoadedText; }
                        updateLabel(); updatePreview(); node.setDirtyCanvas(true);
                        onPick(key, presets[key]);
                    },
                }) },
            });

            // After editing the node's own preset, follow the saved key (or clear
            // the selection when it was deleted) and refresh the read-only preview.
            const followChange = async (savedKey) => {
                presets = await loadPresets({ force: true });
                selectedKey = savedKey && presets[savedKey] ? savedKey : null;
                lastLoadedText = selectedKey ? resolvePresetText(selectedKey, presets) : null;
                textWidget.value = lastLoadedText || "";
                persistKey(); updateLabel(); updatePreview(); node.setDirtyCanvas(true);
            };

            // After editing an arbitrary reusable part, keep the current selection
            // but re-resolve it in case the edited part feeds into it.
            const refreshChange = async () => {
                presets = await loadPresets({ force: true });
                if (selectedKey && !presets[selectedKey]) { selectedKey = null; persistKey(); }
                lastLoadedText = selectedKey ? resolvePresetText(selectedKey, presets) : null;
                textWidget.value = lastLoadedText || "";
                updateLabel(); updatePreview(); node.setDirtyCanvas(true);
            };

            // The single editor — for the node's own preset (follows selection)…
            const openMainEditor = async (editingKey = null) => {
                presets = await loadPresets();
                openPresetEditor({ presets, editingKey, api: editorApi, pickPreset: partPicker, onChanged: followChange });
            };
            // …and for reusable parts (leaves the node's selection alone).
            const openPartEditor = async (editingKey = null) => {
                presets = await loadPresets();
                openPresetEditor({ presets, editingKey, defaultKey: editingKey ? "" : "Parts/", api: editorApi, pickPreset: partPicker, onChanged: refreshChange });
            };

            const openPartsManager = async (anchor = newBtn) => {
                presets = await loadPresets();
                openPresetPicker({
                    anchor, presets, mode: "parts", onSelect: key => openPartEditor(key),
                    createAction: { label: "+ New", run: () => openPartCreator({ presets, api: editorApi, onCreated: refreshChange }) },
                });
            };

            // `items` may contain nulls and { separator: true } so callers can build
            // the list inline with conditionals.
            const showActionMenu = (anchor, id, items) => {
                const { element: menu, dismiss } = openPopover({
                    anchor, id, width: "210px", height: "auto",
                });
                menu.classList.add("pl-popover--menu");
                for (const item of items) {
                    if (!item) continue;
                    if (item.separator) {
                        const line = document.createElement("div");
                        line.className = "pl-menu__sep";
                        menu.append(line);
                        continue;
                    }
                    const action = document.createElement("button");
                    action.type = "button";
                    action.className = `pl-menu__item${item.danger ? " pl-menu__item--danger" : ""}`;
                    action.textContent = item.label;
                    action.onclick = async () => {
                        dismiss();
                        try { await item.run(); }
                        catch (error) { alert(error?.message || "Preset action failed"); }
                    };
                    menu.append(action);
                }
                // Right-aligned under the trigger, which sits at the node's edge.
                const rect = anchor.getBoundingClientRect();
                const box = menu.getBoundingClientRect();
                menu.style.left = `${Math.max(8, Math.min(innerWidth - box.width - 8, rect.right - box.width))}px`;
                menu.style.top = `${Math.max(8, rect.top - box.height - 6)}px`;
            };

            // Primary action: open the unified editor for the current preset.
            const editBtn = makeBtn("Edit", "primary");
            editBtn.dataset.action = "edit";
            editBtn.onclick = () => { if (selectedKey) openMainEditor(selectedKey); };

            const dupBtn = makeBtn("Duplicate");
            dupBtn.dataset.action = "duplicate";
            dupBtn.onclick = () => {
                if (!selectedKey) return;
                promptDialog({
                    title: "Duplicate preset",
                    value: `${selectedKey} copy`,
                    confirmLabel: "Duplicate",
                    // Throwing surfaces the message on the dialog and keeps it open
                    // with the typed name intact, so the user can correct it.
                    onConfirm: async newKey => {
                        const key = validateKey(newKey);
                        presets = await loadPresets();
                        if (presets[key]) throw new Error("A preset with that name already exists");
                        await presetApi.duplicate(selectedKey, key);
                        await followChange(key);
                    },
                });
            };

            const moreBtn = makeBtn("", "icon");
            moreBtn.innerHTML = iconSvg("more", 17);
            moreBtn.title = "Library and preset actions";
            moreBtn.setAttribute("aria-label", "Library and preset actions");
            moreBtn.onclick = () => showActionMenu(moreBtn, "pl-actions-menu", [
                { label: "Browse prompt library", run: () => window.open(`${API_BASE}/browse`, "_blank", "noopener") },
                { label: "Manage reusable parts", run: () => openPartsManager(moreBtn) },
                selectedKey ? { separator: true } : null,
                selectedKey ? { label: presets[selectedKey]?.pinned ? "Unpin preset" : "Pin preset", run: async () => {
                    await presetApi.pin(selectedKey, !presets[selectedKey]?.pinned);
                    presets = await loadPresets({ force: true }); updateLabel();
                } } : null,
                selectedKey ? { label: "Delete preset…", danger: true, run: () => showDeletePopup(selectedKey, () => followChange(null)) } : null,
            ]);

            btnRow.append(editBtn, dupBtn, moreBtn);
            root.appendChild(btnRow);

            return root;
        })());

        // ── SIZE THE UI WIDGET TO ITS CONTENT ────────────────────────────────
        // By default a DOM widget is a "fill" widget: ComfyUI gives it all the
        // node's leftover height, which shows up as an empty gap. Report only the
        // natural height of the visible rows (dropdown + optional preview +
        // buttons) so the native multiline `text` widget fills the rest. The
        // preview row collapses to 0 when hidden, so toggling it re-flows cleanly.
        uiWidget.computeSize = function (width) {
            // Keep the DOM overlay pinned to the node's width. A DOM widget stores
            // its own numeric `width`; if that ever drifts from the node (ComfyUI
            // seeds it from the element's natural content width at creation) the
            // overlay renders at that stale width and overflows the node — and the
            // node looks un-resizable. Native widgets avoid this by leaving `width`
            // undefined; we re-sync it here on every layout pass instead.
            uiWidget.width = node.size[0];

            const root = uiWidget.element;
            let h = 0;
            let visibleRows = 0;
            for (const child of root.children) {
                const ch = child.offsetHeight;
                if (ch > 0) { h += ch; visibleRows++; }
            }
            h += 6 * Math.max(0, visibleRows - 1); // column gap between visible rows
            h += 18;                                // trim slack under the buttons
            return [width, h > 0 ? h : 60];
        };

        // ── WORKFLOW PERSISTENCE ─────────────────────────────────────────────
        node.properties = node.properties || {};

        // Reapply a persisted preview height (set via the drag handle).
        if (node.properties["previewHeight"]) {
            const box = uiWidget.element.querySelector('[data-role="preview-box"]');
            if (box) {
                box.style.height = Math.max(PREVIEW_MIN_HEIGHT,
                    Math.min(PREVIEW_MAX_HEIGHT, node.properties["previewHeight"])) + "px";
            }
        }

        const propertySavedKey = node.properties["selectedKey"];
        const savedKey = propertySavedKey || nativePresetValue;
        const preserveNativeOverride = !propertySavedKey && nativePresetValue && Boolean(textWidget?.value?.trim());
        if (savedKey) {
            loadPresets().then(p => {
                presets = p;
                if (presets[savedKey]) {
                    selectedKey = savedKey;
                    node.properties["selectedKey"] = savedKey;
                    lastLoadedText = resolvePresetText(savedKey, presets);
                    if (textWidget && !preserveNativeOverride) textWidget.value = lastLoadedText;
                    updateLabel();
                    updatePreview();
                    node.setDirtyCanvas(true);
                } else {
                    delete node.properties["selectedKey"];
                }
            }).catch(error => console.error("Could not restore preset selection", error));
        }

        // ── UPDATE HELPERS ───────────────────────────────────────────────────

        function persistKey() {
            if (selectedKey) node.properties["selectedKey"] = selectedKey;
            else delete node.properties["selectedKey"];
            if (presetWidget) presetWidget.value = NONE_CHOICE;
        }

        // Per-node preview toggle. Defaults to ON; persisted in the workflow via
        // node.properties so it survives save/reload. Only an explicit `false`
        // (set from the "Show preset preview" right-click menu) hides it.
        function previewEnabled() {
            return node.properties?.["showPreview"] !== false;
        }

        // Show / hide + populate the in-node preview image. Called whenever the
        // selection, the presets data, or the toggle changes. Kept in sync with
        // `previewEnabled()` so the "Show preset preview" menu item fully controls it.
        function updatePreview() {
            const el        = uiWidget.element;
            const area      = el.querySelector('[data-role="preview-area"]');
            const img       = el.querySelector('[data-role="preview-image"]');
            const noPreview = el.querySelector('[data-role="preview-empty"]');
            const clearBtn  = el.querySelector('[data-role="preview-clear"]');
            if (!area) return;

            const preset = selectedKey ? presets[selectedKey] : null;

            // The "clear" button only makes sense when the preset has an image.
            if (clearBtn) clearBtn.style.display = preset?.preview ? "block" : "none";

            // Hidden only when the toggle is off. When on, the box stays visible
            // even with no preset selected — it shows the NO PREVIEW placeholder.
            if (!previewEnabled()) {
                area.classList.remove("pl-node__preview--on");
                node.setDirtyCanvas(true, true);
                return;
            }

            area.classList.add("pl-node__preview--on");

            if (preset?.preview) {
                img.style.display       = "block";
                noPreview.style.display = "none";
                // preview_version busts the cache on updates; the extra cb param
                // forces a recheck so a deleted file falls back to NO PREVIEW.
                img.src = `${API_BASE}/preview/${encodeURIComponent(preset.preview)}?v=${preset.preview_version ?? 0}`;
                img.onerror = () => {
                    img.style.display       = "none";
                    img.src                 = "";
                    noPreview.style.display = "flex";
                    img.onerror             = null;
                    node.setDirtyCanvas(true, true);
                };
            } else {
                img.style.display       = "none";
                noPreview.style.display = "flex";
            }

            node.setDirtyCanvas(true, true);
        }

        // ── RIGHT-CLICK MENU: TOGGLE PREVIEW ─────────────────────────────────
        // Adds a "Show preset preview" entry to the node's context menu. Enabling
        // grows the node so the preview isn't cramped; disabling reclaims that
        // space. Both paths recompute the DOM widget height via updatePreview().
        const origGetExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            origGetExtraMenuOptions?.apply(this, arguments);
            options.push({
                content: (previewEnabled() ? "✔ " : "") + "Show preset preview",
                callback: () => {
                    const turningOn = !previewEnabled();
                    node.properties["showPreview"] = turningOn;
                    // Grow/shrink the node by the preview's footprint.
                    const delta = (PREVIEW_HEIGHT + 6) * (turningOn ? 1 : -1);
                    node.setSize([node.size[0], Math.max(NODE_MIN_HEIGHT, node.size[1] + delta)]);
                    updatePreview();
                },
            });
        };

        function updateLabel() {
            const label = uiWidget.element.querySelector('[data-role="preset-label"]');
            const { color } = getThemeColors();
            const has = Boolean(selectedKey);
            // Both act on the current selection, so they are dead without one.
            for (const action of ["edit", "duplicate"]) {
                const button = uiWidget.element.querySelector(`[data-action="${action}"]`);
                if (button) button.disabled = !has;
            }

            label.style.color = color;
            label.replaceChildren();
            if (!selectedKey) {
                label.textContent = "— select a prompt —";
                return;
            }

            if (presets[selectedKey]?.pinned) {
                const pin = document.createElement("span");
                pin.className = "pl-node__pin";
                pin.innerHTML = iconSvg("heart", 13);
                label.append(pin);
            }

            const parts = selectedKey.split("/");
            parts.forEach((part, index) => {
                const segment = document.createElement("span");
                segment.textContent = part;
                // The leaf is the preset's own name, so it gets the one colour
                // that is not derived from the category.
                segment.style.color = index === parts.length - 1 ? "#e8c547" : pathTone(part);
                label.append(segment);
                if (index < parts.length - 1) {
                    const slash = document.createElement("span");
                    slash.className = "pl-node__sep";
                    slash.textContent = "/";
                    label.append(slash);
                }
            });

            if (isComposition(presets[selectedKey])) {
                const composed = document.createElement("span");
                composed.className = "pl-node__badge";
                composed.title = "Composition";
                composed.innerHTML = iconSvg("menu", 12);
                label.append(composed);
            }
        }

        // ── THEME CHANGE OBSERVERS ──────────────────────────────────────────
        // Registered here so updateLabel is already defined when they fire.
        // ────────────────────────────────────────────────────────────────────
        function syncTheme() {
            const { bg } = getThemeColors();
            const dropdownEl = uiWidget.element.querySelector('[data-role="preset-label"]')?.parentElement;
            if (dropdownEl) dropdownEl.style.background = bg;
            updateLabel();
        }

        const themeObservers = [];
        const onTextEdited = () => { updateLabel(); node.setDirtyCanvas(true); };
        textWidgetEl?.addEventListener("input", onTextEdited);
        if (textWidgetEl) {
            const textObserver = new MutationObserver(syncTheme);
            textObserver.observe(textWidgetEl, {
                attributes: true, attributeFilter: ["style", "class"]
            });
            themeObservers.push(textObserver);
        }
        const bodyObserver = new MutationObserver(syncTheme);
        bodyObserver.observe(document.body, {
            attributes: true, attributeFilter: ["class", "style"]
        });
        themeObservers.push(bodyObserver);

        const unsubscribeChanges = subscribePresets((nextPresets, change) => {
            const previousText = lastLoadedText;
            presets = nextPresets;
            if (change.content_changed === false && change.key && selectedKey !== change.key) return;
            if (selectedKey && !presets[selectedKey]) {
                selectedKey = null;
                lastLoadedText = null;
                if (textWidget?.value === previousText) textWidget.value = "";
                persistKey();
            } else if (selectedKey && change.content_changed !== false) {
                const nextText = resolvePresetText(selectedKey, presets);
                // Keep a mobile/native text override, but refresh the normal
                // read-only resolved value whenever the preset or a dependency changes.
                if (textWidget?.value === previousText) textWidget.value = nextText;
                lastLoadedText = nextText;
            }
            updateLabel();
            updatePreview();
            node.setDirtyCanvas(true, true);
        });

        const originalRemoved = node.onRemoved;
        node.onRemoved = function () {
            unsubscribeChanges();
            for (const observer of themeObservers) observer.disconnect();
            textWidgetEl?.removeEventListener("input", onTextEdited);
            document.getElementById("pl-shared-picker")?.remove();
            document.getElementById("pl-actions-menu")?.remove();
            document.querySelectorAll(".pl-dialog").forEach(el => el.dismiss?.());
            originalRemoved?.apply(this, arguments);
        };

        // Render the initial state so fresh nodes have correct action and preview UI.
        updateLabel();
        updatePreview();

    },
});
