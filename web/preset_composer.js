const ICON_PATHS = {
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    grip: '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
    gripHorizontal: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
};

export function iconSvg(name, size = 16) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">${ICON_PATHS[name] || ""}</svg>`;
}

export function pathTone(segment) {
    const value = String(segment || "").toLocaleLowerCase();
    if (value === "nsfw") return "#ee8b95";
    if (value === "sfw") return "#79c99a";
    if (value === "parts") return "#91aaff";
    if (value === "manual") return "#c4a7e7";
    return "#8f97a6";
}

export function openPresetPicker({ anchor, presets, currentKey = null, onSelect, mode = "prompts", createAction = null }) {
    document.getElementById("pl-shared-picker")?.remove();
    const isAllowed = key => mode === "parts" ? presetKind(key, presets[key]) === "part" : presetKind(key, presets[key]) !== "part";
    const keys = Object.keys(presets).filter(isAllowed);
    const categoryCounts = new Map();
    for (const key of keys) {
        const path = key.split("/"); path.pop();
        for (let i = 1; i <= path.length; i++) {
            const category = path.slice(0, i).join("/");
            categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
        }
    }
    const categories = [...categoryCounts].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base", numeric: true }));
    let activeCategory = currentKey && isAllowed(currentKey) && currentKey.includes("/") ? currentKey.split("/").slice(0, -1).join("/") : "@all";
    const overlay = element("div"); overlay.id = "pl-shared-picker";
    overlay.style.cssText = "position:fixed;z-index:10040;width:min(560px,calc(100vw - 24px));height:min(430px,calc(100vh - 24px));display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid #343946;border-radius:13px;background:#17191f;color:#eef0f4;box-shadow:0 24px 70px #000c;font:12px/1.4 Inter,system-ui,sans-serif;";
    const header = element("header"); header.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px;border-bottom:1px solid #292d37;";
    const search = element("input"); search.placeholder = mode === "parts" ? "Search reusable parts…" : "Search prompts…";
    search.style.cssText = "min-width:0;flex:1;height:40px;border:1px solid #384052;border-radius:9px;background:#101216;color:#eef0f4;padding:0 11px;outline:none;";
    if (createAction) { const create = element("button", "", createAction.label || "+ New"); create.style.cssText = "height:40px;border:1px solid #88a8ff;border-radius:9px;background:#88a8ff18;color:#a9bcff;padding:0 13px;cursor:pointer;font-weight:650;"; create.onclick = () => { dismiss(); createAction.run(); }; header.append(search, create); }
    else header.append(search);
    const close = element("button"); close.innerHTML = iconSvg("x", 17); close.title = "Close"; close.style.cssText = "width:40px;height:40px;display:grid;place-items:center;padding:0;border:1px solid #343946;border-radius:9px;background:#20232b;color:#cdd1da;cursor:pointer;"; header.append(close);
    const main = element("div"); main.style.cssText = "display:grid;grid-template-columns:165px minmax(0,1fr);grid-template-rows:minmax(0,1fr);min-height:0;";
    const nav = element("aside"); nav.style.cssText = "padding:8px;border-right:1px solid #292d37;overflow:auto;background:#14161b;";
    const content = element("section"); content.style.cssText = "display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0;";
    const crumbs = element("div"); crumbs.style.cssText = "min-height:39px;display:flex;align-items:center;gap:5px;padding:8px 11px;border-bottom:1px solid #292d37;color:#858b99;font-size:10px;overflow:hidden;white-space:nowrap;";
    const results = element("div"); results.style.cssText = "min-height:0;overflow:auto;padding:7px;";
    content.append(crumbs, results); main.append(nav, content); overlay.append(header, main); document.body.append(overlay);
    const dismiss = () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onOutside, true); overlay.remove(); };
    const onKey = event => { if (event.key === "Escape") dismiss(); };
    const onOutside = event => { if (!overlay.contains(event.target) && !anchor?.contains?.(event.target)) dismiss(); };
    close.onclick = dismiss; document.addEventListener("keydown", onKey); setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
    const choose = path => { activeCategory = path; render(); };
    const navButton = (label, count, path, depth = 0) => { const button = element("button"); button.style.cssText = `width:100%;display:flex;align-items:center;gap:6px;padding:8px 8px 8px ${8 + depth * 12}px;border:0;border-radius:7px;background:${activeCategory === path ? "#88a8ff1c" : "transparent"};color:${activeCategory === path ? "#a9beff" : "#a9aebb"};cursor:pointer;text-align:left;font:11px inherit;`; const text = element("span", "", label); text.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"; const badge = element("span", "", count); badge.style.cssText = "margin-left:auto;color:#6f7583;font-size:9px;"; button.append(text, badge); button.onclick = () => choose(path); return button; };
    const renderNav = () => { nav.replaceChildren(); const title = element("div", "", mode === "parts" ? "Part categories" : "Prompt categories"); title.style.cssText = "padding:5px 8px 8px;color:#737a88;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;"; nav.append(title, navButton(mode === "parts" ? "All parts" : "All prompts", keys.length, "@all")); for (const [path, count] of categories) nav.append(navButton(path.split("/").pop(), count, path, Math.min(2, path.split("/").length - 1))); };
    const renderCrumbs = () => { crumbs.replaceChildren(); const root = element("button", "", mode === "parts" ? "Parts" : "Prompts"); root.style.cssText = "border:0;background:transparent;color:#a9beff;padding:2px;cursor:pointer;"; root.onclick = () => choose("@all"); crumbs.append(root); if (activeCategory === "@all") return; let path = ""; for (const part of activeCategory.split("/")) { const slash = element("span", "", "/"); slash.style.color = "#555d6b"; path = path ? `${path}/${part}` : part; const target = path, button = element("button", "", part); button.style.cssText = `border:0;background:transparent;color:${pathTone(part)};padding:2px;cursor:pointer;`; button.onclick = () => choose(target); crumbs.append(slash, button); } };
    const renderResults = () => { const query = search.value.trim().toLocaleLowerCase(); const matching = keys.filter(key => (activeCategory === "@all" || key.startsWith(activeCategory + "/")) && (!query || `${key} ${presets[key]?.text || ""}`.toLocaleLowerCase().includes(query))).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })); results.replaceChildren(); for (const key of matching) { const bits = key.split("/"), name = bits.pop(), button = element("button"); button.style.cssText = `width:100%;display:grid;gap:3px;padding:9px 10px;margin-bottom:3px;border:1px solid ${key === currentKey ? "#88a8ff55" : "transparent"};border-radius:8px;background:${key === currentKey ? "#88a8ff14" : "transparent"};color:#e4e7ed;text-align:left;cursor:pointer;`; const heading = element("strong", "", name); heading.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;"; const path = element("div"); path.style.cssText = "display:flex;gap:4px;overflow:hidden;white-space:nowrap;font-size:9px;"; bits.forEach((part, index) => { const crumb = element("span", "", part); crumb.style.color = pathTone(part); path.append(crumb); if (index < bits.length - 1) { const slash = element("span", "", "/"); slash.style.color = "#555d6b"; path.append(slash); } }); button.append(heading, path); button.onclick = () => { dismiss(); onSelect(key, presets[key]); }; results.append(button); } if (!matching.length) { const empty = element("div", "", mode === "parts" ? "No matching parts" : "No matching prompts"); empty.style.cssText = "padding:28px;color:#737a88;text-align:center;"; results.append(empty); } };
    const render = () => { renderNav(); renderCrumbs(); renderResults(); };
    search.oninput = renderResults; render();
    const rect = anchor?.getBoundingClientRect?.() || { left: 12, bottom: 12, top: 12, right: 572 };
    const box = overlay.getBoundingClientRect();
    overlay.style.left = Math.max(8, Math.min(innerWidth - box.width - 8, rect.left)) + "px";
    overlay.style.top = Math.max(8, Math.min(innerHeight - box.height - 8, rect.bottom + 6)) + "px";
    if (rect.bottom + box.height + 14 > innerHeight) overlay.style.top = Math.max(8, rect.top - box.height - 6) + "px";
    setTimeout(() => search.focus(), 0);
    return overlay;
}

export function normalizeParts(entry) {
    if (!Array.isArray(entry?.parts)) return [];
    return entry.parts.map(part => {
        if (typeof part === "string") return { key: part, enabled: true };
        const key = String(part?.key || "").trim();
        if (key) return { key, enabled: part?.enabled !== false };
        const text = String(part?.text || "");
        return text.trim() ? { text, label: String(part?.label || "Custom"), enabled: part?.enabled !== false } : null;
    }).filter(Boolean);
}

export function presetKind(key, entry) {
    if (normalizeParts(entry).length) return "composition";
    if (key.startsWith("Parts/")) return "part";
    return "prompt";
}

export function resolvePreset(key, presets, stack = []) {
    if (stack.includes(key)) throw new Error(`Circular composition: ${[...stack, key].join(" -> ")}`);
    const entry = presets[key];
    if (!entry) throw new Error(`Missing preset: ${key}`);
    const chunks = normalizeParts(entry)
        .filter(part => part.enabled)
        .map(part => (part.key ? resolvePreset(part.key, presets, [...stack, key]) : part.text).trim())
        .filter(Boolean);
    const own = String(entry.text || "").trim();
    if (own) chunks.push(own);
    return chunks.join("\n\n");
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function createPartsEditor({ presets, initialParts = [], excludeKey = null, getOwnText, onChange = () => {}, pickPreset = null }) {
    let parts = initialParts.map(part => ({ ...part }));
    const editedPresets = new Map();
    presets = Object.fromEntries(Object.entries(presets).map(([key, entry]) => [key, { ...entry }]));
    let activeDrag = null;
    const root = element("section", "plc-parts");
    root.style.cssText = "display:grid;gap:10px;min-width:0;";
    const picker = element("div");
    picker.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;";
    const input = element("input");
    input.placeholder = "Search or choose a preset";
    input.setAttribute("list", `plc-options-${crypto.randomUUID()}`);
    input.style.cssText = "min-width:0;height:42px;border:1px solid #343945;border-radius:10px;background:#111318;color:#eef0f4;padding:0 12px;outline:none;";
    const options = element("datalist");
    options.id = input.getAttribute("list");
    for (const key of Object.keys(presets).filter(key => key !== excludeKey).sort()) {
        const option = element("option"); option.value = key; options.append(option);
    }
    const addCustom = element("button", "", "Add custom");
    addCustom.style.cssText = "height:42px;border:1px solid #3b4250;border-radius:10px;background:#222630;color:#eef0f4;padding:0 14px;cursor:pointer;";
    picker.append(input, options, addCustom);
    if (matchMedia("(max-width:600px)").matches) {
        picker.style.gridTemplateColumns = "1fr 1fr";
        input.style.gridColumn = "1 / -1";
    }
    const list = element("div"); list.style.cssText = "display:grid;gap:7px;";
    const count = element("div"); count.style.cssText = "color:#9198a7;font-size:11px;";
    const preview = element("pre");
    preview.style.cssText = "min-height:110px;max-height:220px;overflow:auto;margin:0;padding:12px;white-space:pre-wrap;color:#bdc3ce;background:#101217;border:1px solid #2a2e38;border-radius:11px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;";

    const changed = () => { onChange(); render(); };
    const move = (index, delta) => {
        const target = index + delta;
        if (target < 0 || target >= parts.length) return;
        [parts[index], parts[target]] = [parts[target], parts[index]];
        changed();
    };
    const smallButton = (label, title, handler) => {
        const button = element("button"); button.type = "button"; button.title = title; button.innerHTML = iconSvg(label, 15);
        button.style.cssText = "width:30px;height:30px;border:1px solid #343945;border-radius:8px;background:#20232b;color:#d4d7df;cursor:pointer;";
        button.onclick = handler; return button;
    };
    function updatePreview() {
        try {
            const chunks = parts.filter(part => part.enabled).map(part => (part.key ? resolvePreset(part.key, presets) : part.text).trim()).filter(Boolean);
            const own = String(getOwnText?.() || "").trim(); if (own) chunks.push(own);
            preview.textContent = chunks.join("\n\n") || "The combined raw prompt appears here.";
        } catch (error) { preview.textContent = error.message; }
    }
    function animatePlacement(placeholder, before) {
        const children = [...list.children].filter(child => child !== placeholder);
        const previous = new Map(children.map(child => [child, child.getBoundingClientRect().top]));
        list.insertBefore(placeholder, before);
        for (const child of children) {
            const delta = previous.get(child) - child.getBoundingClientRect().top;
            if (!delta) continue;
            child.style.transition = "none";
            child.style.transform = `translateY(${delta}px)`;
            requestAnimationFrame(() => {
                child.style.transition = "transform 180ms cubic-bezier(.2,.8,.2,1)";
                child.style.transform = "";
            });
        }
    }
    function beginPointerDrag(event, index, row) {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        const rect = row.getBoundingClientRect();
        const ghost = row.cloneNode(true);
        ghost.style.cssText += `position:fixed;z-index:10050;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;overflow:hidden;opacity:.97;transform:none;transition:box-shadow .12s;border-color:#88a8ff;box-shadow:0 26px 70px #000d,0 0 0 1px #88a8ff66;pointer-events:none;`;
        const placeholder = element("div");
        placeholder.style.cssText = `height:${rect.height}px;box-sizing:border-box;border:1px dashed #88a8ff88;border-radius:11px;background:#88a8ff0a;transition:height .16s;`;
        list.replaceChild(placeholder, row);
        document.body.append(ghost);
        activeDrag = {
            index, ghost, placeholder,
            offsetX: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
            offsetY: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
        };
        const movePointer = moveEvent => {
            if (!activeDrag || moveEvent.pointerId !== event.pointerId) return;
            moveEvent.preventDefault();
            ghost.style.left = `${moveEvent.clientX - activeDrag.offsetX}px`;
            ghost.style.top = `${moveEvent.clientY - activeDrag.offsetY}px`;
            const siblings = [...list.children].filter(child => child !== placeholder);
            const before = siblings.find(child => moveEvent.clientY < child.getBoundingClientRect().top + child.getBoundingClientRect().height / 2) || null;
            if (placeholder.nextElementSibling !== before) animatePlacement(placeholder, before);
        };
        const finish = finishEvent => {
            if (!activeDrag || finishEvent.pointerId !== event.pointerId) return;
            window.removeEventListener("pointermove", movePointer);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", cancel);
            const target = [...list.children].indexOf(placeholder);
            const [moved] = parts.splice(index, 1);
            parts.splice(target, 0, moved);
            ghost.remove(); activeDrag = null; changed();
        };
        const cancel = cancelEvent => {
            if (!activeDrag || cancelEvent.pointerId !== event.pointerId) return;
            window.removeEventListener("pointermove", movePointer);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", cancel);
            ghost.remove(); activeDrag = null; render();
        };
        window.addEventListener("pointermove", movePointer, { passive: false });
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", cancel);
    }
    function render() {
        list.replaceChildren();
        parts.forEach((part, index) => {
            const row = element("div");
            row.style.cssText = `display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:start;gap:9px;padding:9px 10px;border:1px solid #2a2e38;border-radius:11px;background:#13151a;opacity:${part.enabled ? 1 : .5};transition:border-color .14s,transform .14s;`;
            const handle = element("span"); handle.innerHTML = iconSvg("grip", 18);
            handle.title = "Drag to reorder";
            handle.style.cssText = "color:#747c8c;cursor:grab;font-size:18px;line-height:1;user-select:none;touch-action:none;";
            handle.onpointerdown = event => beginPointerDrag(event, index, row);
            const toggle = element("input"); toggle.type = "checkbox"; toggle.checked = part.enabled;
            toggle.onchange = () => { part.enabled = toggle.checked; changed(); };
            const content = element("div"); content.style.cssText = "display:grid;gap:5px;min-width:0;";
            if (part.key) {
                const keyParts = part.key.split("/"), leaf = keyParts.pop();
                const name = element("div"); name.style.cssText = "display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden;white-space:nowrap;font-size:11px;";
                keyParts.forEach((segment, i) => { const crumb = element("span", "", segment); crumb.style.color = pathTone(segment); name.append(crumb); if (i < keyParts.length - 1) { const slash = element("span", "", "/"); slash.style.color = "#555d6b"; name.append(slash); } });
                const title = element("strong", "", leaf); title.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;color:#e4e7ed;font-size:12px;";
                const text = element("textarea"); text.value = editedPresets.get(part.key) ?? presets[part.key]?.text ?? ""; text.placeholder = "Reusable part text";
                text.style.cssText = "width:100%;min-height:120px;resize:vertical;border:1px solid #2f3440;border-radius:8px;background:#0f1116;color:#e1e3e9;padding:8px;box-sizing:border-box;outline:none;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;";
                text.oninput = () => {
                    editedPresets.set(part.key, text.value);
                    if (presets[part.key]) presets[part.key].text = text.value;
                    onChange(); updatePreview();
                };
                content.append(name, title, text);
            } else {
                const label = element("input"); label.value = part.label || "Custom"; label.title = "Part label";
                const text = element("textarea"); text.value = part.text || ""; text.placeholder = "Custom prompt text";
                label.style.cssText = "min-width:0;border:0;background:transparent;color:#9ca4b3;font-size:11px;outline:none;";
                text.style.cssText = "width:100%;min-height:120px;resize:vertical;border:1px solid #2f3440;border-radius:8px;background:#0f1116;color:#e1e3e9;padding:8px;box-sizing:border-box;outline:none;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;";
                label.oninput = () => { part.label = label.value; onChange(); };
                text.oninput = () => { part.text = text.value; onChange(); updatePreview(); };
                content.append(label, text);
            }
            const actions = element("span"); actions.style.cssText = "display:flex;gap:4px;";
            actions.append(smallButton("up", "Move up", () => move(index, -1)), smallButton("down", "Move down", () => move(index, 1)), smallButton("x", "Remove", () => { parts.splice(index, 1); changed(); }));
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
    if (pickPreset) {
        picker.style.gridTemplateColumns = "minmax(0,1fr) auto";
        input.style.gridColumn = "auto";
        input.readOnly = true;
        input.removeAttribute("list");
        input.placeholder = "Browse reusable presets…";
        input.style.cursor = "pointer";
        input.onclick = () => pickPreset(input, (key, entry = null) => {
            if (!key || key === excludeKey) return;
            addSelected(key, entry);
        });
        options.remove();
    }
    addCustom.onclick = () => { parts.push({ text: "", label: "Custom", enabled: true }); onChange(); render(); };
    root.append(picker, count, list, element("div", "", "Resolved output"), preview);
    render();
    return {
        element: root,
        getParts: () => parts.map(part => ({ ...part })),
        getEditedPresets: () => [...editedPresets].map(([key, text]) => ({ key, text })),
        refresh: render,
    };
}

export async function openComposerModal({ presets, editingKey = null, save, pickPreset = null }) {
    document.getElementById("pl-composer-modal")?.dismiss?.();
    const existing = editingKey ? presets[editingKey] : null;
    const overlay = element("div"); overlay.id = "pl-composer-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:10020;display:grid;place-items:center;padding:24px;background:#050609b8;backdrop-filter:blur(7px);";
    const panel = element("section"); panel.style.cssText = "display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(860px,96vw);max-height:92vh;overflow:hidden;border:1px solid #343945;border-radius:18px;background:#17191f;color:#eef0f4;box-shadow:0 30px 100px #000c;font:13px/1.45 Inter,system-ui,sans-serif;";
    const header = element("header"); header.style.cssText = "display:flex;align-items:center;padding:18px 20px;border-bottom:1px solid #2a2e38;";
    header.append(element("strong", "", existing ? "Edit composition" : "New composition"));
    const close = element("button"); close.innerHTML = iconSvg("x", 18); close.style.cssText = "margin-left:auto;width:36px;height:36px;display:grid;place-items:center;padding:0;border:1px solid #343945;border-radius:10px;background:#20232b;color:#eef0f4;cursor:pointer;"; header.append(close);
    const body = element("div"); body.style.cssText = "overflow:auto;padding:20px;";
    const label = text => { const node = element("label", "", text); node.style.cssText = "display:block;margin:0 0 6px;color:#9aa1af;font-size:12px;"; return node; };
    const name = element("input"); name.value = editingKey || ""; name.placeholder = "Compositions/Anime portrait";
    name.style.cssText = "width:100%;border:1px solid #343945;border-radius:10px;background:#111318;color:#eef0f4;padding:11px 12px;outline:none;box-sizing:border-box;";
    body.append(label("Composition name"), name, label("Ordered parts"));
    const initialParts = normalizeParts(existing);
    if (existing?.text?.trim()) initialParts.push({ text: existing.text, label: "Legacy text", enabled: true });
    const editor = createPartsEditor({ presets, initialParts, excludeKey: editingKey, getOwnText: () => "", pickPreset });
    body.append(editor.element);
    const footer = element("footer"); footer.style.cssText = "display:flex;justify-content:flex-end;gap:9px;padding:14px 20px;border-top:1px solid #2a2e38;";
    const cancel = element("button", "", "Cancel"), submit = element("button", "", existing ? "Update composition" : "Create composition");
    for (const button of [cancel, submit]) button.style.cssText = "min-height:40px;border:1px solid #343945;border-radius:10px;background:#20232b;color:#eef0f4;padding:0 15px;cursor:pointer;";
    submit.style.cssText += "background:#88a8ff;border-color:#88a8ff;color:#10131a;font-weight:700;";
    footer.append(cancel, submit); panel.append(header, body, footer); overlay.append(panel); document.body.append(overlay);
    const dismiss = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
    const onKey = event => { if (event.key === "Escape") dismiss(); };
    overlay.dismiss = dismiss; close.onclick = cancel.onclick = dismiss; overlay.onclick = event => { if (event.target === overlay) dismiss(); }; document.addEventListener("keydown", onKey);
    submit.onclick = async () => {
        const key = name.value.trim(); if (!key) { name.setCustomValidity("Enter a composition name"); name.reportValidity(); return; }
        if (!editingKey && presets[key]) { name.setCustomValidity("A preset with this name already exists"); name.reportValidity(); return; }
        submit.disabled = true;
        try { await save({ oldKey: editingKey, key, text: "", parts: editor.getParts(), editedPresets: editor.getEditedPresets() }); dismiss(); }
        catch (error) { alert(error.message); submit.disabled = false; }
    };
    setTimeout(() => name.focus(), 0);
    return overlay;
}

export async function openPartModal({ presets, editingKey = null, save, remove = null }) {
    document.getElementById("pl-part-modal")?.dismiss?.();
    const existing = editingKey ? presets[editingKey] : null;
    const overlay = element("div"); overlay.id = "pl-part-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:10022;display:grid;place-items:center;padding:24px;background:#050609b8;backdrop-filter:blur(7px);";
    const panel = element("section"); panel.style.cssText = "display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(680px,96vw);max-height:90vh;overflow:hidden;border:1px solid #343945;border-radius:18px;background:#17191f;color:#eef0f4;box-shadow:0 30px 100px #000c;font:13px/1.45 Inter,system-ui,sans-serif;";
    const header = element("header"); header.style.cssText = "display:flex;align-items:center;padding:18px 20px;border-bottom:1px solid #2a2e38;";
    header.append(element("strong", "", existing ? "Edit reusable part" : "New reusable part"));
    const close = element("button"); close.innerHTML = iconSvg("x", 18); close.style.cssText = "margin-left:auto;width:36px;height:36px;display:grid;place-items:center;padding:0;border:1px solid #343945;border-radius:10px;background:#20232b;color:#eef0f4;cursor:pointer;"; header.append(close);
    const body = element("div"); body.style.cssText = "overflow:auto;padding:20px;";
    const makeLabel = text => { const node = element("label", "", text); node.style.cssText = "display:block;margin:0 0 6px;color:#9aa1af;font-size:12px;"; return node; };
    const name = element("input"); name.value = editingKey || "Parts/"; name.placeholder = "Parts/Camera/Close-up";
    name.style.cssText = "width:100%;border:1px solid #343945;border-radius:10px;background:#111318;color:#eef0f4;padding:11px 12px;outline:none;box-sizing:border-box;";
    const hint = element("div", "", "Reusable parts live under Parts/ and can be inserted into any composed prompt."); hint.style.cssText = "margin:6px 0 16px;color:#747b89;font-size:11px;";
    const text = element("textarea"); text.value = existing?.text || ""; text.placeholder = "Prompt fragment or wildcard block…";
    text.style.cssText = "display:block;width:100%;min-height:260px;resize:vertical;border:1px solid #343945;border-radius:10px;background:#111318;color:#eef0f4;padding:12px;outline:none;box-sizing:border-box;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;";
    body.append(makeLabel("Part name"), name, hint, makeLabel("Prompt text"), text);
    const footer = element("footer"); footer.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:9px;padding:14px 20px;border-top:1px solid #2a2e38;";
    const cancel = element("button", "", "Cancel"), submit = element("button", "", existing ? "Update part" : "Create part");
    for (const button of [cancel, submit]) button.style.cssText = "min-height:40px;border:1px solid #343945;border-radius:10px;background:#20232b;color:#eef0f4;padding:0 15px;cursor:pointer;";
    if (existing && remove) { const del = element("button", "", "Delete"); del.style.cssText = "min-height:40px;margin-right:auto;border:1px solid #59353a;border-radius:10px;background:#24171a;color:#ee858b;padding:0 15px;cursor:pointer;"; del.onclick = async () => { if (!confirm(`Delete ${editingKey}?`)) return; del.disabled = true; try { await remove(editingKey); dismiss(); } catch (error) { alert(error.message); del.disabled = false; } }; footer.append(del); }
    submit.style.cssText += "background:#88a8ff;border-color:#88a8ff;color:#10131a;font-weight:700;";
    footer.append(cancel, submit); panel.append(header, body, footer); overlay.append(panel); document.body.append(overlay);
    const dismiss = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
    const onKey = event => { if (event.key === "Escape") dismiss(); };
    overlay.dismiss = dismiss; close.onclick = cancel.onclick = dismiss; overlay.onclick = event => { if (event.target === overlay) dismiss(); }; document.addEventListener("keydown", onKey);
    submit.onclick = async () => {
        let key = name.value.trim().replace(/^\/+/, "");
        if (!key.toLocaleLowerCase().startsWith("parts/")) key = `Parts/${key}`;
        name.value = key;
        if (key === "Parts/" || !text.value.trim()) { name.setCustomValidity(key === "Parts/" ? "Enter a part name" : "Enter prompt text"); name.reportValidity(); return; }
        if (!editingKey && presets[key]) { name.setCustomValidity("A preset with this name already exists"); name.reportValidity(); return; }
        name.setCustomValidity(""); submit.disabled = true;
        try { await save({ oldKey: editingKey, key, text: text.value }); dismiss(); }
        catch (error) { alert(error.message); submit.disabled = false; }
    };
    setTimeout(() => { name.focus(); name.setSelectionRange(name.value.length, name.value.length); }, 0);
    return overlay;
}
