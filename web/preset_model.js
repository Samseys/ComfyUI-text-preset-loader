// =============================================================================
// preset_model.js — the preset data model, with no DOM in it.
//
// This is the browser-side twin of preset_model.py. Both files describe the
// same shape (a preset is an ordered list of parts; a part is either a
// reference to another preset or inline text) and the same name rules.
//
// KEEP IN SYNC WITH preset_model.py. The server is still the authority — it
// re-validates everything — but duplicating the rules here is what lets the
// editor reject a bad name inline instead of letting the user find out from a
// failed POST. If you change a rule there, change it here.
// =============================================================================

// Mirrors MAX_KEY_LENGTH / _WINDOWS_RESERVED / _INVALID_PATH_CHARS.
const MAX_KEY_LENGTH = 240;
const INVALID_PATH_CHARS = new Set('<>:"|?*\\');
const WINDOWS_RESERVED = new Set([
    "CON", "PRN", "AUX", "NUL",
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Mirrors preset_model.canonicalize_key. */
export function canonicalKey(value) {
    const key = String(value || "").trim().replace(/^\/+/, "");
    return key.slice(0, 6).toLowerCase() === "parts/" ? `Parts/${key.slice(6)}` : key;
}

// Python's PurePath(segment).stem — everything before the final dot, except a
// leading dot which marks a hidden name rather than an extension.
function segmentStem(segment) {
    const dot = segment.lastIndexOf(".");
    return dot > 0 ? segment.slice(0, dot) : segment;
}

/**
 * Mirrors preset_model.validate_key. Returns the canonical name, or throws an
 * Error whose message matches the server's wording for the same input.
 */
export function validateKey(value) {
    const key = canonicalKey(value);
    if (!key) throw new Error("Preset name cannot be empty");
    if (key.length > MAX_KEY_LENGTH) {
        throw new Error(`Preset name cannot exceed ${MAX_KEY_LENGTH} characters`);
    }
    for (const char of key) {
        if (char.codePointAt(0) < 32 || INVALID_PATH_CHARS.has(char)) {
            throw new Error("Preset name contains unsupported characters");
        }
    }

    const segments = key.split("/");
    if (segments.some(segment => !segment)) {
        throw new Error("Preset name cannot contain empty path segments");
    }
    for (const segment of segments) {
        if (segment === "." || segment === "..") {
            throw new Error("Preset name cannot contain '.' or '..' segments");
        }
        if (segment.endsWith(" ") || segment.endsWith(".")) {
            throw new Error("Preset path segments cannot end with a space or period");
        }
        if (WINDOWS_RESERVED.has(segmentStem(segment).toUpperCase())) {
            throw new Error(`Preset path segment "${segment}" is reserved`);
        }
    }
    if (key === "Parts") throw new Error("Reusable parts require a name under Parts/");
    return key;
}

/** Mirrors preset_model.normalize_parts (lenient mode). */
export function normalizeParts(entry) {
    if (!Array.isArray(entry?.parts)) return [];
    return entry.parts.map(part => {
        if (typeof part === "string") return { key: canonicalKey(part), enabled: true };
        const key = canonicalKey(part?.key);
        const enabled = typeof part?.enabled === "boolean" ? part.enabled : true;
        if (key) return { key, enabled };
        const text = String(part?.text || "");
        return text.trim() ? { text, label: String(part?.label || "Custom"), enabled } : null;
    }).filter(Boolean);
}

// Unified model: content is always parts. "part" vs "prompt" is purely a
// namespace convention (Parts/ = meant to be reused inside other presets).
export function presetKind(key, entry) {
    return key.startsWith("Parts/") ? "part" : "prompt";
}

// A preset is a "composition" (for badge/display purposes only) when it pulls in
// at least one other preset by reference. A preset made only of inline text is
// just a plain prompt, regardless of how many text blocks it has.
export function isComposition(entry) {
    return normalizeParts(entry).some(part => part.key);
}

// Editable inline text for a preset that is a single inline-text part (or empty).
// Returns null for a multi-part composition — those are edited on their own,
// not inline from a parent, so a parent editor shows them read-only.
export function simpleLeafText(entry) {
    const parts = normalizeParts(entry);
    if (parts.length === 0) return "";
    if (parts.length === 1 && !parts[0].key) return parts[0].text || "";
    return null;
}

// Resolved text is memoised per presets object. The store hands out frozen
// snapshots, so a WeakMap keyed on the snapshot lets every caller share one
// cache that is dropped automatically when the snapshot is replaced. Callers
// holding a mutable draft get a throwaway cache for that single call instead.
const resolutionCaches = new WeakMap();

/** Mirrors preset_model.resolve_preset: enabled parts, in order, blank-line joined. */
export function resolvePreset(key, presets, stack = [], memo = null) {
    if (!memo) {
        if (Object.isFrozen(presets)) {
            memo = resolutionCaches.get(presets);
            if (!memo) {
                memo = new Map();
                resolutionCaches.set(presets, memo);
            }
        } else {
            memo = new Map();
        }
    }
    if (memo.has(key)) return memo.get(key);
    if (stack.includes(key)) throw new Error(`Circular composition: ${[...stack, key].join(" -> ")}`);
    const entry = presets[key];
    if (!entry) throw new Error(`Missing preset: ${key}`);
    const parts = normalizeParts(entry);
    // Backward-compat: a hand-edited entry with only a bare `text` field.
    if (!parts.length) {
        const text = String(entry.text || "").trim();
        memo.set(key, text);
        return text;
    }
    const text = parts
        .filter(part => part.enabled)
        .map(part => (part.key ? resolvePreset(part.key, presets, [...stack, key], memo) : part.text).trim())
        .filter(Boolean)
        .join("\n\n");
    memo.set(key, text);
    return text;
}
