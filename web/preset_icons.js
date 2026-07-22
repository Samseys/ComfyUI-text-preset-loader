// =============================================================================
// preset_icons.js — leaf-level UI helpers shared by every other web module.
//
// This module imports nothing. It exists so preset_dialog.js and
// preset_composer.js can both use iconSvg() without importing each other,
// which would make their dependency cycle load-order dependent.
// =============================================================================

// Icon geometry is vendored verbatim from Lucide (lucide-static v1.25.0, ISC).
// https://lucide.dev — see LICENSE-lucide.txt for the upstream notice.
//
// Inlined rather than fetched: the browse page runs under a strict CSP with no
// external origins, ComfyUI serves web/ verbatim with no build step, and the
// node UI is injected into ComfyUI's DOM where a shared sprite sheet could
// collide. The comment on each row is the upstream icon name — to add or update
// one, copy the children of the <svg> element from that icon's source file.
const ICON_PATHS = {
    x:              '<path d="M18 6 6 18"/> <path d="m6 6 12 12"/>',  // lucide x
    down:           '<path d="m6 9 6 6 6-6"/>',  // lucide chevron-down
    grip:           '<circle cx="9" cy="12" r="1"/> <circle cx="9" cy="5" r="1"/> <circle cx="9" cy="19" r="1"/> <circle cx="15" cy="12" r="1"/> <circle cx="15" cy="5" r="1"/> <circle cx="15" cy="19" r="1"/>',  // lucide grip-vertical
    gripHorizontal: '<circle cx="12" cy="9" r="1"/> <circle cx="19" cy="9" r="1"/> <circle cx="5" cy="9" r="1"/> <circle cx="12" cy="15" r="1"/> <circle cx="19" cy="15" r="1"/> <circle cx="5" cy="15" r="1"/>',  // lucide grip-horizontal
    more:           '<circle cx="12" cy="12" r="1"/> <circle cx="19" cy="12" r="1"/> <circle cx="5" cy="12" r="1"/>',  // lucide ellipsis
    plus:           '<path d="M5 12h14"/> <path d="M12 5v14"/>',  // lucide plus
    heart:          '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/>',  // lucide heart
    menu:           '<path d="M4 5h16"/> <path d="M4 12h16"/> <path d="M4 19h16"/>',  // lucide menu
    chevronRight:   '<path d="m9 18 6-6-6-6"/>',  // lucide chevron-right
    image:          '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/> <circle cx="9" cy="9" r="2"/> <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',  // lucide image
};

// The wrapper reproduces Lucide's own default attributes, so the vendored path
// data renders exactly as upstream does. stroke="currentColor" is what lets a
// single definition inherit whatever colour its container sets.
export function iconSvg(name, size = 16) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">${ICON_PATHS[name] || ""}</svg>`;
}

// Stable colour per category segment, so the same folder reads the same way in
// the node label, the picker and the library. Named cases first because those
// carry meaning; everything else falls back to one neutral tone.
export function pathTone(segment) {
    const value = String(segment || "").toLocaleLowerCase();
    if (value === "nsfw") return "#ee8b95";
    if (value === "sfw") return "#79c99a";
    if (value === "parts") return "#91aaff";
    if (value === "manual") return "#c4a7e7";
    return "#8f97a6";
}

export function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
