// The parts editor and the two dialogs built on it: the single preset editor
// (shared by the canvas node and the /browse page) and the reusable-part
// creator. The data model and the drag engine live in their own modules; this
// is the DOM layer.
import {
    canonicalKey,
    normalizeParts,
    resolvePreset,
    simpleLeafText,
    validateKey,
} from "../core/model.js";
import { beginPointerDrag } from "./dnd.js";
import { confirmDialog, dialogButton, footerSpacer, openDialog } from "./dialog.js";
import { element, iconSvg, pathTone } from "./icons.js";

// crypto.randomUUID() only exists in secure contexts (HTTPS/localhost). Phones
// reach ComfyUI over plain-HTTP LAN IPs, where it is undefined and throws, so
// fall back to a plain unique id generator.
let uidCounter = 0;
function uid() {
    return `${Date.now().toString(36)}-${(uidCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}


export function createPartsEditor({ presets, initialParts = [], excludeKey = null, onChange = () => {}, pickPreset = null }) {
    let parts = initialParts.map(part => ({ ...part }));
    const editedPresets = new Map();
    presets = Object.fromEntries(Object.entries(presets).map(([key, entry]) => [key, { ...entry }]));
    const root = element("section", "pl-parts");
    const picker = element("div", "pl-parts__picker");
    const input = element("input", "pl-parts__search");
    input.placeholder = "Search or choose a preset";
    input.setAttribute("list", `plc-options-${uid()}`);
    const options = element("datalist");
    options.id = input.getAttribute("list");
    for (const key of Object.keys(presets).filter(key => key !== excludeKey).sort()) {
        const option = element("option"); option.value = key; options.append(option);
    }
    const addCustom = element("button", "pl-parts__add", "Add custom");
    addCustom.type = "button";
    picker.append(input, options, addCustom);
    const list = element("div", "pl-parts__list");
    const count = element("div", "pl-parts__count");
    const preview = element("pre", "pl-resolved");

    const changed = () => { onChange(); render(); };
    const smallButton = (label, title, handler) => {
        const button = element("button", "pl-btn pl-btn--icon pl-btn--sm");
        button.type = "button";
        button.title = title;
        button.setAttribute("aria-label", title);
        button.innerHTML = iconSvg(label, 15);
        button.onclick = handler;
        return button;
    };
    function updatePreview() {
        try {
            const chunks = parts.filter(part => part.enabled).map(part => (part.key ? resolvePreset(part.key, presets) : part.text).trim()).filter(Boolean);
            preview.textContent = chunks.join("\n\n") || "The combined raw prompt appears here.";
        } catch (error) { preview.textContent = error.message; }
    }
    // Reordering lives in dnd.js; this only says what a drop means.
    const startDrag = (event, index, row) => beginPointerDrag({
        event, index, row, list,
        onDrop: (from, to) => {
            const [moved] = parts.splice(from, 1);
            parts.splice(to, 0, moved);
            changed();
        },
        onCancel: render,
    });
    function render() {
        list.replaceChildren();
        parts.forEach((part, index) => {
            const row = element("div", `pl-part${part.enabled ? "" : " pl-part--off"}`);
            const handle = element("span", "pl-drag-handle");
            handle.innerHTML = iconSvg("grip", 18);
            handle.title = "Drag to reorder";
            handle.setAttribute("aria-label", "Drag to reorder");
            handle.onpointerdown = event => startDrag(event, index, row);
            const toggle = element("input"); toggle.type = "checkbox"; toggle.checked = part.enabled;
            toggle.onchange = () => { part.enabled = toggle.checked; changed(); };
            const content = element("div", "pl-part__content");
            if (part.key) {
                const keyParts = part.key.split("/"), leaf = keyParts.pop();
                const name = element("div", "pl-part__name");
                keyParts.forEach((segment, i) => {
                    const crumb = element("span", "", segment);
                    crumb.style.color = pathTone(segment);
                    name.append(crumb);
                    if (i < keyParts.length - 1) name.append(element("span", "pl-crumb-sep", "/"));
                });
                const title = element("strong", "pl-part__title", leaf);
                const editable = editedPresets.has(part.key)
                    ? (editedPresets.get(part.key)[0]?.text ?? "")
                    : simpleLeafText(presets[part.key]);
                if (editable !== null) {
                    // The referenced preset is a single block of text — edit it in place.
                    const text = element("textarea", "pl-code"); text.value = editable; text.placeholder = "Reusable part text";
                    text.oninput = () => {
                        const nextParts = text.value.trim() ? [{ text: text.value, label: "Text", enabled: true }] : [];
                        editedPresets.set(part.key, nextParts);
                        if (presets[part.key]) presets[part.key] = { ...presets[part.key], parts: nextParts };
                        onChange(); updatePreview();
                    };
                    content.append(name, title, text);
                } else {
                    // The referenced preset is itself a composition — show its resolved
                    // output read-only; it is edited on its own, not from here.
                    const note = element("div", "pl-part__note", "Composition — open it separately to change its parts.");
                    const resolved = element("pre", "pl-code pl-code--readonly");
                    try { resolved.textContent = resolvePreset(part.key, presets); } catch (error) { resolved.textContent = error.message; }
                    content.append(name, title, note, resolved);
                }
            } else {
                const label = element("input", "pl-part__label"); label.value = part.label || "Custom"; label.title = "Part label";
                const text = element("textarea", "pl-code"); text.value = part.text || ""; text.placeholder = "Custom prompt text";
                label.oninput = () => { part.label = label.value; onChange(); };
                text.oninput = () => { part.text = text.value; onChange(); updatePreview(); };
                content.append(label, text);
            }
            const actions = element("span", "pl-part__actions");
            actions.append(smallButton("x", "Remove part", () => { parts.splice(index, 1); changed(); }));
            row.append(handle, toggle, content, actions); list.append(row);
        });
        count.textContent = `${parts.length} part${parts.length === 1 ? "" : "s"}`;
        updatePreview();
    }
    const addSelected = (key, entry = null) => {
        key = String(key || "").trim();
        if (entry) presets[key] = { ...entry };
        if (!presets[key] || key === excludeKey) { input.setCustomValidity("Choose an existing preset"); input.reportValidity(); return; }
        input.setCustomValidity(""); parts.push({ key, enabled: true }); input.value = ""; changed();
    };
    input.oninput = () => input.setCustomValidity("");
    input.onkeydown = event => { if (event.key === "Enter" && !pickPreset) { event.preventDefault(); addSelected(input.value); } };
    // With a picker available the field stops being a typed search and becomes
    // a button that opens it, so the datalist is dropped to avoid two competing
    // dropdowns on the same input.
    if (pickPreset) {
        picker.classList.add("pl-parts__picker--browse");
        input.readOnly = true;
        input.removeAttribute("list");
        input.placeholder = "Browse reusable presets…";
        input.onclick = () => pickPreset(input, (key, entry = null) => {
            if (!key || key === excludeKey) return;
            addSelected(key, entry);
        });
        options.remove();
    }
    addCustom.onclick = () => { parts.push({ text: "", label: "Custom", enabled: true }); onChange(); render(); };
    root.append(picker, count, list, element("div", "pl-label", "Resolved output"), preview);
    render();
    return {
        element: root,
        getParts: () => parts.map(part => ({ ...part })),
        getEditedPresets: () => [...editedPresets].map(([key, parts]) => ({ key, parts })),
        refresh: render,
    };
}

// Existing category paths (each ending in "/") derived from preset keys, for
// name autocomplete. `onlyParts` restricts to the Parts/ tree.
function categoryPaths(presets, onlyParts = false) {
    const set = new Set();
    for (const key of Object.keys(presets)) {
        if (onlyParts && !key.startsWith("Parts/")) continue;
        const segments = key.split("/"); segments.pop();
        let path = "";
        for (const segment of segments) { path = path ? `${path}/${segment}` : segment; set.add(path + "/"); }
    }
    return [...set].sort();
}

// Wrap a name input with a compact, in-modal category-suggestion dropdown that
// only appears while typing (a native <datalist> renders oversized in the
// desktop app and covers the field below). Returns the wrapper to insert.
function attachCategorySuggest(input, categories) {
    const wrap = element("div", "pl-suggest-wrap");
    const suggest = element("div", "pl-suggest"); suggest.style.display = "none";
    wrap.append(input, suggest);
    const render = () => {
        const query = input.value.trim().toLocaleLowerCase();
        const matches = categories.filter(category => category.toLocaleLowerCase() !== query && category.toLocaleLowerCase().includes(query)).slice(0, 8);
        suggest.replaceChildren();
        if (!matches.length) { suggest.style.display = "none"; return; }
        for (const category of matches) {
            const row = element("button", "pl-suggest__item", category); row.type = "button";
            // mousedown, not click: the input's blur handler hides the list
            // before a click would land.
            row.onmousedown = event => { event.preventDefault(); input.value = category; suggest.style.display = "none"; input.focus(); input.setSelectionRange(category.length, category.length); };
            suggest.append(row);
        }
        suggest.style.display = "block";
    };
    input.addEventListener("input", render);
    input.addEventListener("blur", () => setTimeout(() => { suggest.style.display = "none"; }, 120));
    input.addEventListener("keydown", event => { if (event.key === "Escape" && suggest.style.display === "block") { event.stopPropagation(); suggest.style.display = "none"; } });
    return wrap;
}

// The single preset editor, shared by the canvas node and the /browse page.
// Every preset — plain prompt, composition, or reusable part — is edited here:
// a name, an ordered list of parts (references + inline text), a resolved-output
// preview, a preview image, and pin/delete. `api` decouples it from transport so
// both callers reuse it against the same /preset_loader endpoints.
//
//   api.save(key, parts)   api.rename(oldKey, newKey)   api.remove(key)
//   api.pin(key, pinned)   api.setPreview(key, file)    api.clearPreview(key)
//   api.list() -> presets  api.notify?(message)
//
// `onChanged(key|null)` fires after any successful mutation so the caller can
// follow the selection (null after a delete).
export async function openPresetEditor({ presets, editingKey = null, initialParts = null, defaultKey = "", closeOnSave = false, api, pickPreset = null, onChanged = null }) {
    let working = presets;
    let currentKey = editingKey;

    const dialog = openDialog({ title: editingKey ? "Edit preset" : "New preset" });
    const { overlay, body, footer, dismiss } = dialog;

    const label = text => element("label", "pl-label", text);
    const name = element("input", "pl-field"); name.value = editingKey || defaultKey || ""; name.placeholder = "Characters/Heroes/example";
    const nameHint = element("div", "pl-hint", "Use / to nest into categories. A Parts/… name marks a reusable part.");

    // New presets open with one focused inline-text row so the common case
    // (a single block of prompt text) is still just "type · name · save".
    let startParts;
    if (editingKey) {
        startParts = normalizeParts(presets[editingKey]);
        // Safety net for a hand-edited / legacy bare-text entry: seed one inline part.
        if (!startParts.length && presets[editingKey]?.text) startParts = [{ text: presets[editingKey].text, label: "Text", enabled: true }];
    } else {
        startParts = initialParts && initialParts.length ? initialParts : [{ text: "", label: "Text", enabled: true }];
    }
    const editor = createPartsEditor({ presets: working, initialParts: startParts, excludeKey: editingKey, pickPreset });

    const media = element("div");
    const fileInput = element("input"); fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";

    const nameGroup = element("div", "pl-field-group");
    nameGroup.append(label("Preset name"), attachCategorySuggest(name, categoryPaths(working)), nameHint);
    const partsGroup = element("div", "pl-field-group");
    partsGroup.append(label("Parts"), editor.element);
    body.append(nameGroup, partsGroup, media, fileInput);

    const pinBtn = dialogButton("Pin");
    const delBtn = dialogButton("Delete", "danger");
    const cancel = dialogButton("Cancel");
    const submit = dialogButton("Save preset", "primary");
    cancel.onclick = dismiss;
    footer.append(pinBtn, delBtn, footerSpacer(), cancel, submit);

    function renderMedia() {
        media.replaceChildren();
        const box = element("div", "pl-media__box");
        // A preview is stored against a saved key, so there is nowhere to put
        // one until the preset exists.
        if (!currentKey) {
            box.append(element("span", "pl-media__hint", "Save the preset to add a preview image."));
            media.append(label("Preview"), box);
            return;
        }
        const preset = working[currentKey] || {};
        if (preset.preview) {
            const image = element("img");
            image.alt = "";
            image.src = `/preset_loader/preview/${encodeURIComponent(preset.preview)}?v=${preset.preview_version || 0}`;
            box.append(image);
        } else {
            box.append(element("span", "pl-media__hint", "No preview image"));
        }
        const actions = element("div", "pl-media__actions");
        const choose = element("button", "pl-btn pl-btn--md", "Choose preview");
        choose.type = "button";
        choose.onclick = () => fileInput.click(); actions.append(choose);
        if (preset.preview) {
            const remove = element("button", "pl-btn pl-btn--md", "Remove");
            remove.type = "button";
            remove.onclick = async () => { try { await api.clearPreview(currentKey); working = await api.list(); renderMedia(); onChanged?.(currentKey); } catch (error) { alert(error.message); } };
            actions.append(remove);
        }
        media.append(label("Preview"), box, actions);
    }
    fileInput.onchange = async () => {
        const file = fileInput.files[0]; if (!file || !currentKey) return;
        try { await api.setPreview(currentKey, file); working = await api.list(); renderMedia(); onChanged?.(currentKey); }
        catch (error) { alert(error.message); }
        fileInput.value = "";
    };

    function renderActions() {
        pinBtn.style.display = currentKey ? "" : "none";
        delBtn.style.display = currentKey ? "" : "none";
        if (currentKey) pinBtn.textContent = working[currentKey]?.pinned ? "Unpin" : "Pin";
    }
    pinBtn.onclick = async () => {
        if (!currentKey) return;
        try { await api.pin(currentKey, !working[currentKey]?.pinned); working = await api.list(); renderActions(); onChanged?.(currentKey); }
        catch (error) { alert(error.message); }
    };
    delBtn.onclick = () => {
        if (!currentKey) return;
        // Stacks over this editor so a refusal from the server (the preset may
        // still be referenced by a composition) is shown where it happened.
        const name = element("strong", "", `"${currentKey}"`);
        const message = document.createDocumentFragment();
        message.append("Delete ", name, " permanently?");
        confirmDialog({
            title: "Delete preset",
            message,
            detail: "This cannot be undone.",
            confirmLabel: "Delete",
            onConfirm: async () => { await api.remove(currentKey); onChanged?.(null); dismiss(); },
        });
    };

    submit.onclick = async () => {
        let key;
        // Same rules the server enforces, so an illegal name is caught here
        // rather than coming back as a failed POST.
        try { key = validateKey(name.value); }
        catch (error) { name.setCustomValidity(error.message); name.reportValidity(); return; }
        name.value = key;
        if (key !== currentKey && working[key]) { name.setCustomValidity("A preset with that name already exists"); name.reportValidity(); return; }
        name.setCustomValidity(""); submit.disabled = true;
        try {
            const edited = editor.getEditedPresets();
            let result = null;
            if (api.commit) {
                result = await api.commit({ currentKey, key, parts: editor.getParts(), edited });
            } else {
                for (const item of edited) await api.save(item.key, item.parts);
                if (currentKey && key !== currentKey) await api.rename(currentKey, key);
                await api.save(key, editor.getParts());
            }
            const savedKey = result?.key || key;
            working = await api.list();
            currentKey = savedKey;
            name.value = savedKey;
            dialog.setTitle("Edit preset");
            await onChanged?.(savedKey);
            api.notify?.("Preset saved");
            // Create-and-add flow (e.g. a new reusable part from a composition):
            // close this layer once saved so focus returns to the parent editor.
            if (closeOnSave) { dismiss(); return; }
            renderMedia(); renderActions();
        } catch (error) { alert(error.message); }
        submit.disabled = false;
    };

    renderMedia(); renderActions();
    setTimeout(() => { if (editingKey) name.focus(); else { const ta = editor.element.querySelector("textarea"); (ta || name).focus(); } }, 30);
    return overlay;
}

// A reusable part is just a block of text, so creating one is a lean name + text
// box — no parts list, preview, or pin. Stacks over an open editor (via the shared
// shared dialog stack) so it can create-and-add mid-composition. On success it
// saves the part as a single inline-text part and calls onCreated(key).
export function openPartCreator({ presets, defaultKey = "Parts/", api, onCreated = null }) {
    const dialog = openDialog({ title: "New reusable part", width: "min(640px,96vw)" });
    const { overlay, body, footer, dismiss } = dialog;
    const makeLabel = text => element("label", "pl-label", text);
    const name = element("input", "pl-field"); name.value = defaultKey; name.placeholder = "Parts/Camera/Close-up";
    // Suggest existing Parts/ category paths as you type.
    const nameWrap = attachCategorySuggest(name, categoryPaths(presets, true));
    const hint = element("div", "pl-hint", "Reusable parts live under Parts/ and can be inserted into any prompt.");
    const text = element("textarea", "pl-field pl-field--code"); text.placeholder = "Prompt fragment or wildcard block…";
    const partNameGroup = element("div", "pl-field-group");
    partNameGroup.append(makeLabel("Part name"), nameWrap, hint);
    const partTextGroup = element("div", "pl-field-group");
    partTextGroup.append(makeLabel("Text"), text);
    body.append(partNameGroup, partTextGroup);
    const cancel = dialogButton("Cancel");
    const submit = dialogButton("Create part", "primary");
    cancel.onclick = dismiss;
    footer.append(footerSpacer(), cancel, submit);
    submit.onclick = async () => {
        let key = canonicalKey(name.value);
        if (!key.startsWith("Parts/")) key = `Parts/${key}`;
        name.value = key;
        if (key === "Parts/" || !text.value.trim()) { name.setCustomValidity(key === "Parts/" ? "Enter a part name" : "Enter text"); name.reportValidity(); return; }
        // Same rules the server enforces, so an illegal name is caught here
        // rather than coming back as a failed POST.
        try { key = validateKey(key); name.value = key; }
        catch (error) { name.setCustomValidity(error.message); name.reportValidity(); return; }
        if (presets[key]) { name.setCustomValidity("A preset with that name already exists"); name.reportValidity(); return; }
        name.setCustomValidity(""); submit.disabled = true;
        try { await api.save(key, [{ text: text.value, label: "Text", enabled: true }]); await onCreated?.(key); dismiss(); }
        catch (error) { alert(error.message); submit.disabled = false; }
    };
    setTimeout(() => { name.focus(); name.setSelectionRange(name.value.length, name.value.length); }, 30);
    return overlay;
}
