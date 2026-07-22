// =============================================================================
// preset_dialog.js — every overlay in the plugin.
//
// Two shapes, because they behave differently:
//
//   openDialog()   modal. Backdrop, centred, stacks, traps Escape.
//   openPopover()  anchored. No backdrop, positioned against a trigger element,
//                  dismissed by clicking away.
//
// Both are here so backdrop, stacking, Escape and teardown have exactly one
// definition. Anything that opens over the page goes through one of them, and
// both expose `dismiss` on the element so a caller holding only the node (node
// teardown in preset_loader.js) can close it.
// =============================================================================

import { element, iconSvg } from "./preset_icons.js";

// Dialogs can stack (creating a reusable part from inside the preset editor),
// so each layer sits above the previous one and Escape only closes the topmost.
let dialogDepth = 0;
const DIALOG_CLASS = "pl-dialog";

/**
 * Open a modal dialog.
 *
 *   title      heading text
 *   width      CSS width for the panel (default: the wide editor size)
 *   tone       "default" | "danger" — danger tints the heading and border
 *   onDismiss  called after the dialog is removed, however it was closed
 *
 * Returns { overlay, panel, body, footer, dismiss, setTitle }. The caller fills
 * `body` and appends its own buttons to `footer`; this module owns only the
 * chrome. `overlay.dismiss` is also set so callers holding just the element
 * (e.g. node teardown in preset_loader.js) can close it.
 */
export function openDialog({ title, width = "min(880px,96vw)", tone = "default", onDismiss = null } = {}) {
    const depth = dialogDepth++;

    const overlay = element("div", `${DIALOG_CLASS}${tone === "danger" ? " pl-dialog--danger" : ""}`);
    overlay.id = `pl-dialog-${depth}`;
    // Stacking order is the only per-instance geometry; everything else is CSS.
    overlay.style.zIndex = 10020 + depth * 4;

    const panel = element("section", "pl-dialog__panel");
    panel.style.width = width;

    const header = element("header", "pl-dialog__header");
    const titleEl = element("strong", "pl-dialog__title", title || "");
    const close = element("button", "pl-btn pl-btn--icon pl-btn--close");
    close.type = "button";
    close.innerHTML = iconSvg("x", 18);
    close.setAttribute("aria-label", "Close");
    header.append(titleEl, close);

    const body = element("div", "pl-dialog__body");
    const footer = element("footer", "pl-dialog__footer");

    panel.append(header, body, footer);
    overlay.append(panel);
    document.body.append(overlay);

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        onDismiss?.();
    };
    const onKey = event => {
        if (event.key !== "Escape") return;
        // Only the topmost dialog reacts, so Escape peels the stack one layer
        // at a time instead of closing everything at once.
        const all = document.querySelectorAll(`.${DIALOG_CLASS}`);
        if (all[all.length - 1] === overlay) dismiss();
    };
    document.addEventListener("keydown", onKey);
    close.onclick = dismiss;
    overlay.onclick = event => { if (event.target === overlay) dismiss(); };
    overlay.dismiss = dismiss;

    return {
        overlay, panel, body, footer, dismiss,
        setTitle: text => { titleEl.textContent = text; },
    };
}

/**
 * Open a panel anchored to `anchor`, with no backdrop.
 *
 *   id     when given, opening another popover with the same id replaces it,
 *          so a trigger cannot stack duplicates of its own panel
 *   size   CSS width/height for the panel
 *
 * Returns { element, dismiss, reposition }. Fill `element` first, then call
 * reposition() — placement depends on the panel's rendered height.
 */
export function openPopover({ anchor, id = null, width = "min(560px,calc(100vw - 24px))", height = "min(430px,calc(100vh - 24px))", onDismiss = null } = {}) {
    if (id) document.getElementById(id)?.remove();

    const panel = element("div", "pl-popover");
    if (id) panel.id = id;
    panel.style.width = width;
    panel.style.height = height;
    document.body.append(panel);

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("pointerdown", onOutside, true);
        panel.remove();
        onDismiss?.();
    };
    const onKey = event => { if (event.key === "Escape") dismiss(); };
    // Capture phase, so a click lands on the popover's own controls before the
    // dismissal check runs. The anchor is excluded or its click would reopen it.
    const onOutside = event => {
        if (!panel.contains(event.target) && !anchor?.contains?.(event.target)) dismiss();
    };
    document.addEventListener("keydown", onKey);
    // Deferred by a tick, otherwise the click that opened this closes it again.
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
    panel.dismiss = dismiss;

    const reposition = () => {
        const rect = anchor?.getBoundingClientRect?.() || { left: 12, bottom: 12, top: 12 };
        const box = panel.getBoundingClientRect();
        panel.style.left = `${Math.max(8, Math.min(innerWidth - box.width - 8, rect.left))}px`;
        panel.style.top = `${Math.max(8, Math.min(innerHeight - box.height - 8, rect.bottom + 6))}px`;
        // Flip above the anchor when there is not enough room below it.
        if (rect.bottom + box.height + 14 > innerHeight) {
            panel.style.top = `${Math.max(8, rect.top - box.height - 6)}px`;
        }
    };

    return { element: panel, dismiss, reposition };
}

/** A footer button. `variant`: "default" | "primary" | "danger". */
export function dialogButton(label, variant = "default") {
    const button = element("button", `pl-btn${variant === "default" ? "" : ` pl-btn--${variant}`}`, label);
    button.type = "button";
    return button;
}

/** Pushes everything after it to the right-hand side of the footer. */
export function footerSpacer() {
    return element("div", "pl-dialog__spacer");
}

/**
 * Confirm/cancel prompt. `onConfirm` may return false to keep the dialog open;
 * anything it throws is surfaced on the dialog rather than through alert().
 */
export function confirmDialog({ title, message, detail = "", confirmLabel = "Confirm", tone = "danger", onConfirm }) {
    const dialog = openDialog({ title, width: "min(430px,96vw)", tone });

    const text = element("div", "pl-dialog__message");
    text.append(message);
    dialog.body.append(text);
    if (detail) dialog.body.append(element("div", "pl-dialog__detail", detail));
    const error = element("div", "pl-dialog__error");
    error.style.display = "none";
    dialog.body.append(error);

    const cancel = dialogButton("Cancel");
    const confirm = dialogButton(confirmLabel, tone === "danger" ? "danger" : "primary");
    cancel.onclick = dialog.dismiss;
    confirm.onclick = async () => {
        confirm.disabled = true;
        error.style.display = "none";
        try {
            if (await onConfirm() !== false) dialog.dismiss();
            else confirm.disabled = false;
        } catch (failure) {
            error.textContent = failure?.message || "The action failed";
            error.style.display = "block";
            confirm.disabled = false;
        }
    };
    dialog.footer.append(footerSpacer(), cancel, confirm);
    return dialog;
}

/**
 * Single-text-field prompt (rename, duplicate). `onConfirm(value)` may return
 * false to keep the dialog open.
 */
export function promptDialog({ title, value = "", placeholder = "Category/Subcategory/Name", confirmLabel = "Save", onConfirm }) {
    const dialog = openDialog({ title, width: "min(430px,96vw)" });

    const input = element("input", "pl-field");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    const error = element("div", "pl-dialog__error");
    error.style.display = "none";
    dialog.body.append(input, error);

    const cancel = dialogButton("Cancel");
    const confirm = dialogButton(confirmLabel, "primary");
    cancel.onclick = dialog.dismiss;
    confirm.onclick = async () => {
        const entered = input.value.trim();
        if (!entered) { input.focus(); return; }
        confirm.disabled = true;
        error.style.display = "none";
        try {
            if (await onConfirm(entered) !== false) dialog.dismiss();
            else confirm.disabled = false;
        } catch (failure) {
            error.textContent = failure?.message || "The action failed";
            error.style.display = "block";
            confirm.disabled = false;
        }
    };
    input.onkeydown = event => {
        if (event.key === "Enter") { event.preventDefault(); confirm.click(); }
    };
    dialog.footer.append(footerSpacer(), cancel, confirm);
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return dialog;
}
