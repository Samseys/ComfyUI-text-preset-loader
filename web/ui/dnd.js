// =============================================================================
// dnd.js — pointer-based reordering for the parts list.
//
// Not HTML5 drag-and-drop: that API has no usable touch support, and dragging is
// the only way to reorder a part, so it has to work on a phone. Pointer events
// cover mouse, touch and pen with one code path.
//
// The dragged row is replaced by a same-height placeholder while a floating
// clone follows the pointer. Reordering moves the placeholder only; the caller's
// array is mutated once, on drop.
// =============================================================================

// Distance from a scroll edge at which autoscroll kicks in, and its top speed.
// A phone screen shows only two or three rows, so without this a part could
// never be dragged past the ones already visible.
const EDGE_ZONE_PX = 64;
const MAX_SCROLL_STEP_PX = 16;

/** Nearest ancestor that actually scrolls vertically. */
function scrollableAncestor(node) {
    for (let element = node.parentElement; element; element = element.parentElement) {
        const overflow = getComputedStyle(element).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight) {
            return element;
        }
    }
    return null;
}

/**
 * Slide the surviving rows to their new positions (FLIP: read old positions,
 * move the placeholder, then animate each row from its old offset to zero).
 */
function animatePlacement(list, placeholder, before) {
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

/**
 * Begin dragging `row` (at `index`) within `list`.
 *
 * onDrop(from, to) fires with the final indices; onCancel() fires if the drag is
 * aborted. Listeners live on `window`, not the row, so the drag survives the
 * pointer leaving the element, and they are torn down on both exit paths.
 */
export function beginPointerDrag({ event, index, row, list, onDrop, onCancel }) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();

    // Only measured geometry is set inline; the look lives in styles/ui.css.
    const rect = row.getBoundingClientRect();
    const ghost = row.cloneNode(true);
    ghost.classList.add("pl-drag-ghost");
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    const placeholder = document.createElement("div");
    placeholder.className = "pl-drag-placeholder";
    placeholder.style.height = `${rect.height}px`;
    list.replaceChild(placeholder, row);
    document.body.append(ghost);

    const offsetX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const offsetY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const scroller = scrollableAncestor(list);
    let pointerY = event.clientY;
    let frame = null;

    // Where the placeholder belongs for a given pointer position: before the
    // first row whose midpoint is below the pointer.
    const placeAt = clientY => {
        const siblings = [...list.children].filter(child => child !== placeholder);
        const before = siblings.find(child => {
            const box = child.getBoundingClientRect();
            return clientY < box.top + box.height / 2;
        }) || null;
        if (placeholder.nextElementSibling !== before) animatePlacement(list, placeholder, before);
    };

    // Autoscroll runs on its own frame loop rather than off pointermove: while a
    // finger rests in the edge zone no move events fire, but the list must keep
    // scrolling. Re-running placeAt each frame keeps the drop target correct as
    // content slides under a stationary pointer.
    const tick = () => {
        frame = requestAnimationFrame(tick);
        if (!scroller) return;
        const box = scroller.getBoundingClientRect();
        let ratio = 0;
        if (pointerY < box.top + EDGE_ZONE_PX) {
            ratio = -(box.top + EDGE_ZONE_PX - pointerY) / EDGE_ZONE_PX;
        } else if (pointerY > box.bottom - EDGE_ZONE_PX) {
            ratio = (pointerY - (box.bottom - EDGE_ZONE_PX)) / EDGE_ZONE_PX;
        }
        if (!ratio) return;
        const before = scroller.scrollTop;
        scroller.scrollTop += Math.max(-1, Math.min(1, ratio)) * MAX_SCROLL_STEP_PX;
        if (scroller.scrollTop !== before) placeAt(pointerY);
    };
    frame = requestAnimationFrame(tick);

    const teardown = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancelEvent);
        ghost.remove();
    };
    const onMove = moveEvent => {
        if (moveEvent.pointerId !== event.pointerId) return;
        moveEvent.preventDefault();
        pointerY = moveEvent.clientY;
        ghost.style.left = `${moveEvent.clientX - offsetX}px`;
        ghost.style.top = `${moveEvent.clientY - offsetY}px`;
        placeAt(moveEvent.clientY);
    };
    const onUp = upEvent => {
        if (upEvent.pointerId !== event.pointerId) return;
        const target = [...list.children].indexOf(placeholder);
        teardown();
        onDrop?.(index, target);
    };
    const onCancelEvent = cancelEvent => {
        if (cancelEvent.pointerId !== event.pointerId) return;
        teardown();
        onCancel?.();
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancelEvent);
}
