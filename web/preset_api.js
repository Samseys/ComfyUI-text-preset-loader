const API_BASE = "/preset_loader";
const REQUEST_TIMEOUT_MS = 60_000;

export class PresetApiError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = "PresetApiError";
        this.status = status;
    }
}

async function parseResponse(response) {
    let data;
    try {
        data = await response.json();
    } catch (_) {
        throw new PresetApiError("The server returned an invalid response", response.status);
    }
    if (!response.ok || data?.status === "error") {
        throw new PresetApiError(data?.message || `Request failed (${response.status})`, response.status);
    }
    if (response.headers.get("X-Preset-Loader-Warning")) {
        console.warn("Preset Loader is displaying recovery data because presets.json is invalid.");
    }
    return data;
}

async function request(path, { method = "GET", body, form = false } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const options = {
        method,
        cache: "no-store",
        signal: controller.signal,
        headers: form || body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : (form ? body : JSON.stringify(body)),
    };
    try {
        const response = await fetch(`${API_BASE}${path}`, options);
        return await parseResponse(response);
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new PresetApiError("The preset request timed out");
        }
        if (error instanceof PresetApiError) throw error;
        throw new PresetApiError(error?.message || "Could not reach the preset service");
    } finally {
        clearTimeout(timeout);
    }
}

export const presetApi = {
    base: API_BASE,
    list: () => request("/list"),
    save: (key, parts, text) => request("/save", {
        method: "POST",
        body: parts === undefined ? { key, text } : { key, parts },
    }),
    commit: ({ currentKey = null, key, parts, edited = [] }) => request("/batch", {
        method: "POST",
        body: { current_key: currentKey, key, parts, edited },
    }),
    rename: (oldKey, newKey) => request("/rename", {
        method: "POST",
        body: { old_key: oldKey, new_key: newKey },
    }),
    duplicate: (sourceKey, newKey) => request("/duplicate", {
        method: "POST",
        body: { source_key: sourceKey, new_key: newKey },
    }),
    remove: key => request("/delete", { method: "POST", body: { key } }),
    pin: (key, pinned) => request("/pin", { method: "POST", body: { key, pinned } }),
    touch: key => request("/touch", { method: "POST", body: { key } }),
    setPreview: (key, file) => {
        const form = new FormData();
        form.append("key", key);
        form.append("file", file);
        return request("/set_preview", { method: "POST", body: form, form: true });
    },
    clearPreview: key => request("/clear_preview", { method: "POST", body: { key } }),
};
