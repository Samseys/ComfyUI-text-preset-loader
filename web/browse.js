import {
    normalizeParts,
    resolvePreset,
    presetKind,
    isComposition,
} from "./preset_model.js";
import { openPresetEditor, openPartCreator } from "./preset_editor.js";
import { openPresetPicker } from "./preset_picker.js";
import { iconSvg, pathTone } from "./preset_icons.js";
import { presetApi } from "./preset_api.js";
import { loadPresets, subscribePresets } from "./preset_store.js";

const $ = selector => document.querySelector(selector);
const PAGE_SIZE = 48;
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

let presets = {};
let rows = [];
let visible = PAGE_SIZE;
let activeCategory = "@prompts";
const normalized = new Map();

const grid = $("#grid");
const more = $("#more");
const search = $("#search");
const sort = $("#sort");
const categories = $("#categories");
const crumbs = $("#crumbs");
const folders = $("#folders");
const categoryShade = $("#category-shade");

$("#category-toggle .menu-icon").innerHTML = iconSvg("menu", 17);

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function indexRows() {
    normalized.clear();
    rows = Object.keys(presets).map(key => {
        const pathParts = key.split("/");
        const name = pathParts.pop();
        const searchableParts = normalizeParts(presets[key])
            .map(part => part.key || part.text || "")
            .join(" ");
        normalized.set(key, `${key} ${searchableParts}`.toLocaleLowerCase());
        return { key, name, path: pathParts.join(" / "), parts: pathParts };
    });
    if (activeCategory && !activeCategory.startsWith("@") &&
        !rows.some(row => row.key.startsWith(`${activeCategory}/`))) {
        activeCategory = "@prompts";
    }
    applySort();
    renderCategories();
}

function applySort() {
    rows.sort((a, b) => sort.value === "category"
        ? collator.compare(a.path, b.path) || collator.compare(a.name, b.name)
        : collator.compare(a.name, b.name));
}

function categoryMatches(row) {
    const entry = presets[row.key];
    if (activeCategory === "@prompts") return presetKind(row.key) !== "part";
    if (activeCategory === "@parts") return presetKind(row.key) === "part";
    if (activeCategory === "@pinned") return Boolean(entry?.pinned);
    if (activeCategory === "@recent") return Boolean(entry?.last_used_at);
    return presetKind(row.key) !== "part" && row.key.startsWith(`${activeCategory}/`);
}

function filteredRows() {
    const query = search.value.trim().toLocaleLowerCase();
    return rows.filter(row => categoryMatches(row) &&
        (!query || normalized.get(row.key).includes(query)));
}

function categoryEntries() {
    const counts = new Map();
    for (const row of rows.filter(item => presetKind(item.key) !== "part")) {
        for (let index = 1; index <= row.parts.length; index += 1) {
            const path = row.parts.slice(0, index).join("/");
            counts.set(path, (counts.get(path) || 0) + 1);
        }
    }
    return [...counts].sort((a, b) => collator.compare(a[0], b[0]));
}

function openCategories() {
    categories.classList.add("open");
    categoryShade.classList.add("open");
    document.body.classList.add("categories-open");
    $("#category-toggle").setAttribute("aria-expanded", "true");
}

function closeCategories() {
    categories.classList.remove("open");
    categoryShade.classList.remove("open");
    document.body.classList.remove("categories-open");
    $("#category-toggle").setAttribute("aria-expanded", "false");
}

function chooseCategory(path) {
    activeCategory = path;
    visible = PAGE_SIZE;
    renderCategories();
    render();
    if (matchMedia("(max-width:820px)").matches) closeCategories();
}

function renderCategories() {
    const head = element("div", "category-head");
    const title = element("div", "category-title", "Library");
    const close = element("button", "button category-close");
    close.innerHTML = iconSvg("x", 17);
    close.type = "button";
    close.setAttribute("aria-label", "Close categories");
    close.onclick = closeCategories;
    head.append(title, close);
    categories.replaceChildren(head);

    const add = (name, count, path, depth = 0) => {
        const button = element("button", `category depth-${depth}${activeCategory === path ? " active" : ""}`);
        const label = element("span", "label", name);
        const badge = element("span", "badge", String(count));
        button.append(label, badge);
        button.onclick = () => chooseCategory(path);
        categories.append(button);
    };

    add("Prompts", rows.filter(row => presetKind(row.key) !== "part").length, "@prompts");
    add("Parts", rows.filter(row => presetKind(row.key) === "part").length, "@parts");
    const pinned = rows.filter(row => presets[row.key]?.pinned).length;
    const recent = rows.filter(row => presets[row.key]?.last_used_at).length;
    if (pinned) add("Pinned", pinned, "@pinned");
    if (recent) add("Recent", recent, "@recent");

    categories.append(element("div", "category-title", "Prompt categories"));
    for (const [path, count] of categoryEntries()) {
        add(path.split("/").pop(), count, path, Math.min(2, path.split("/").length - 1));
    }
}

function renderCrumbs() {
    crumbs.replaceChildren();
    const labels = { "@prompts": "Prompts", "@parts": "Parts", "@pinned": "Pinned", "@recent": "Recent" };
    if (activeCategory.startsWith("@")) {
        crumbs.append(element("span", "crumb current", labels[activeCategory] || "Library"));
        return;
    }

    const root = element("button", "crumb", "Prompts");
    root.onclick = () => chooseCategory("@prompts");
    crumbs.append(root);
    let path = "";
    for (const part of activeCategory.split("/")) {
        crumbs.append(element("span", "", "/"));
        path = path ? `${path}/${part}` : part;
        const target = path;
        const button = element("button", `crumb${target === activeCategory ? " current" : ""}`, part);
        button.onclick = () => chooseCategory(target);
        crumbs.append(button);
    }
}

function renderFolders() {
    folders.replaceChildren();
    if (activeCategory.startsWith("@")) return;
    const depth = activeCategory ? activeCategory.split("/").length : 0;
    const children = new Map();
    for (const [path, count] of categoryEntries()) {
        const parts = path.split("/");
        if (parts.length !== depth + 1) continue;
        if (activeCategory && !path.startsWith(`${activeCategory}/`)) continue;
        children.set(path, count);
    }
    for (const [path, count] of children) {
        const button = element("button", "folder");
        const icon = element("span", "folder-icon");
        const copy = element("span", "folder-copy");
        icon.innerHTML = iconSvg("chevronRight", 16);
        copy.append(
            element("div", "folder-name", path.split("/").pop()),
            element("div", "folder-count", `${count} preset${count === 1 ? "" : "s"}`),
        );
        button.append(icon, copy);
        button.onclick = () => chooseCategory(path);
        folders.append(button);
    }
}

function breadcrumb(path, className = "path") {
    const node = element("div", className);
    const parts = String(path || "").split("/").map(part => part.trim()).filter(Boolean);
    if (!parts.length) {
        node.textContent = "Uncategorised";
        return node;
    }
    parts.forEach((part, index) => {
        const crumb = element("span", "", part);
        crumb.style.color = pathTone(part);
        node.append(crumb);
        if (index < parts.length - 1) {
            const slash = element("span", "", "/");
            slash.style.cssText = "color:#555d6b;margin:0 4px";
            node.append(slash);
        }
    });
    return node;
}

function excerptText(key) {
    try {
        return resolvePreset(key, presets);
    } catch (error) {
        return error.message || "";
    }
}

function presetCard(row) {
    const preset = presets[row.key] || {};
    const card = element("article", "card");
    const pin = element("button", `pin${preset.pinned ? " active" : ""}`);
    const preview = element("div", "preview");

    pin.innerHTML = iconSvg("heart", 17);
    pin.title = preset.pinned ? "Unpin preset" : "Pin preset";
    pin.onclick = async event => {
        event.stopPropagation();
        try {
            await presetApi.pin(row.key, !preset.pinned);
            await reload();
            notify(preset.pinned ? "Preset unpinned" : "Preset pinned");
        } catch (error) {
            notify(error.message);
        }
    };

    if (preset.preview) {
        const image = new Image();
        image.loading = "lazy";
        image.alt = row.name;
        image.src = `/preset_loader/preview/${encodeURIComponent(preset.preview)}?v=${preset.preview_version || 0}`;
        image.onerror = () => preview.replaceChildren(element("span", "placeholder", "Preview unavailable"));
        preview.append(image);
    } else {
        preview.append(element("span", "placeholder", "No preview"));
    }
    preview.onclick = () => openEditor(row.key);

    const body = element("div", "body");
    body.append(
        breadcrumb(row.path),
        element("div", "name", row.name),
        element("div", "excerpt", excerptText(row.key)),
    );
    if (isComposition(preset)) body.append(element("span", "composition-badge", "Composition"));

    const actions = element("div", "actions");
    const copy = element("button", "button", "Copy");
    const edit = element("button", "button", "Edit");
    copy.onclick = async () => {
        try {
            await copyText(resolvePreset(row.key, presets));
            presetApi.touch(row.key).catch(() => {});
            notify("Prompt copied");
        } catch (error) {
            notify(error.message);
        }
    };
    edit.onclick = () => openEditor(row.key);
    actions.append(copy, edit);
    body.append(actions);
    card.append(pin, preview, body);
    return card;
}

function render(reset = false) {
    if (reset) visible = PAGE_SIZE;
    renderCrumbs();
    renderFolders();
    const list = filteredRows();
    const fragment = document.createDocumentFragment();
    for (const row of list.slice(0, visible)) fragment.append(presetCard(row));
    grid.replaceChildren(fragment);
    if (!list.length) grid.append(element("div", "empty", "No matching presets in this category"));
    more.hidden = visible >= list.length;
    const scope = activeCategory ? ` in ${activeCategory.replaceAll("/", " / ")}` : "";
    $("#count").textContent = `${list.length.toLocaleString()} preset${list.length === 1 ? "" : "s"}${scope}`;
}

function scheduleRender() {
    clearTimeout(scheduleRender.timer);
    scheduleRender.timer = setTimeout(() => render(true), 70);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (_) {
        const textarea = element("textarea");
        textarea.value = text;
        document.body.append(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
    }
}

function notify(text) {
    const toast = $("#toast");
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove("show"), 1300);
}

async function reload({ preserve = true } = {}) {
    presets = await loadPresets({ force: true });
    indexRows();
    render(!preserve);
}

const browserApi = {
    ...presetApi,
    list: () => loadPresets({ force: true }),
    notify,
};

function partPicker(anchor, onPick) {
    openPresetPicker({
        anchor,
        presets,
        mode: "parts",
        onSelect: onPick,
        createAction: {
            label: "+ New",
            run: () => openPartCreator({
                presets,
                api: browserApi,
                onCreated: async key => {
                    await reload();
                    onPick(key, presets[key]);
                },
            }),
        },
    });
}

function openEditor(key = null) {
    openPresetEditor({
        presets,
        editingKey: key,
        api: browserApi,
        pickPreset: partPicker,
        onChanged: () => reload(),
    });
}

$("#category-toggle").onclick = openCategories;
categoryShade.onclick = closeCategories;
$("#new").onclick = () => openEditor();
document.addEventListener("keydown", event => { if (event.key === "Escape") closeCategories(); });
search.oninput = scheduleRender;
sort.onchange = () => { applySort(); render(true); };
more.onclick = () => { visible += PAGE_SIZE; render(); };

subscribePresets((nextPresets) => {
    presets = nextPresets;
    indexRows();
    render();
});

reload({ preserve: false })
    .then(() => {
        if (new URLSearchParams(location.search).get("compose") === "1") openEditor();
    })
    .catch(error => {
        grid.replaceChildren(element("div", "empty", `Could not load presets: ${error.message}`));
    });
