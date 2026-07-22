// The browse/select popover — a searchable, category-filtered list for
// choosing an existing preset or part. It only ever reports a choice back
// through `onSelect`/`createAction`; it has no opinion on what happens next,
// which is what keeps it decoupled from the editor.
import { normalizeParts, presetKind } from "../core/model.js";
import { openPopover } from "./dialog.js";
import { element, iconSvg, pathTone } from "./icons.js";

export function openPresetPicker({ anchor, presets, currentKey = null, onSelect, mode = "prompts", createAction = null }) {
    document.getElementById("pl-shared-picker")?.remove();
    const isAllowed = key => mode === "parts" ? presetKind(key) === "part" : presetKind(key) !== "part";
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
    const popover = openPopover({ anchor, id: "pl-shared-picker" });
    const { element: overlay, dismiss } = popover;
    const header = element("header", "pl-picker__header");
    const search = element("input", "pl-picker__search");
    search.placeholder = mode === "parts" ? "Search reusable parts…" : "Search prompts…";
    header.append(search);
    if (createAction) {
        const create = element("button", "pl-btn pl-btn--accent", createAction.label || "+ New");
        create.onclick = () => { dismiss(); createAction.run(); };
        header.append(create);
    }
    const close = element("button", "pl-btn pl-btn--icon");
    close.innerHTML = iconSvg("x", 17);
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    header.append(close);
    const main = element("div", "pl-picker__main");
    const nav = element("aside", "pl-picker__nav");
    const content = element("section", "pl-picker__content");
    const crumbs = element("div", "pl-picker__crumbs");
    const results = element("div", "pl-picker__results");
    content.append(crumbs, results); main.append(nav, content); overlay.append(header, main);
    close.onclick = dismiss;
    const choose = path => { activeCategory = path; render(); };
    const navButton = (label, count, path, depth = 0) => {
        const button = element("button", `pl-nav-item${activeCategory === path ? " pl-nav-item--active" : ""}`);
        button.style.setProperty("--pl-depth", depth);
        button.append(element("span", "pl-nav-item__label", label),
                      element("span", "pl-nav-item__badge", count));
        button.onclick = () => choose(path);
        return button;
    };

    const renderNav = () => {
        nav.replaceChildren(
            element("div", "pl-picker__nav-title", mode === "parts" ? "Part categories" : "Prompt categories"),
            navButton(mode === "parts" ? "All parts" : "All prompts", keys.length, "@all"),
        );
        for (const [path, count] of categories) {
            nav.append(navButton(path.split("/").pop(), count, path, Math.min(2, path.split("/").length - 1)));
        }
    };

    const renderCrumbs = () => {
        const root = element("button", "pl-crumb", mode === "parts" ? "Parts" : "Prompts");
        root.onclick = () => choose("@all");
        crumbs.replaceChildren(root);
        if (activeCategory === "@all") return;
        let path = "";
        for (const part of activeCategory.split("/")) {
            path = path ? `${path}/${part}` : part;
            const target = path;
            const button = element("button", "pl-crumb", part);
            button.style.color = pathTone(part);
            button.onclick = () => choose(target);
            crumbs.append(element("span", "pl-crumb-sep", "/"), button);
        }
    };

    // Matches on the full key plus each part's key/text, so a prompt can be
    // found by something it contains rather than only by its name.
    const renderResults = () => {
        const query = search.value.trim().toLocaleLowerCase();
        const matching = keys
            .filter(key => (activeCategory === "@all" || key.startsWith(`${activeCategory}/`))
                && (!query || `${key} ${normalizeParts(presets[key]).map(p => p.key || p.text || "").join(" ")}`
                    .toLocaleLowerCase().includes(query)))
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));

        results.replaceChildren();
        for (const key of matching) {
            const bits = key.split("/");
            const name = bits.pop();
            const button = element("button", `pl-result${key === currentKey ? " pl-result--current" : ""}`);
            const path = element("div", "pl-result__path");
            bits.forEach((part, index) => {
                const crumb = element("span", "", part);
                crumb.style.color = pathTone(part);
                path.append(crumb);
                if (index < bits.length - 1) path.append(element("span", "pl-crumb-sep", "/"));
            });
            button.append(element("strong", "pl-result__name", name), path);
            button.onclick = () => { dismiss(); onSelect(key, presets[key]); };
            results.append(button);
        }
        if (!matching.length) {
            results.append(element("div", "pl-empty", mode === "parts" ? "No matching parts" : "No matching prompts"));
        }
    };
    const render = () => { renderNav(); renderCrumbs(); renderResults(); };
    search.oninput = renderResults; render();
    popover.reposition();
    setTimeout(() => search.focus(), 0);
    return overlay;
}
