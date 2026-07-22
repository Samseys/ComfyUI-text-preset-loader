import { presetApi } from "./api.js";

let snapshot = Object.freeze({});
let loaded = false;
let reloadPromise = null;
let reloadRequested = false;
let pendingNotify = false;
let pendingDetail = {};
let eventSource = null;
let resyncHandler = null;
let resyncTimer = null;
const listeners = new Set();

function notify(detail = {}) {
    for (const listener of [...listeners]) {
        try {
            listener(snapshot, detail);
        } catch (error) {
            console.error("Preset listener failed", error);
        }
    }
}

async function runReloads() {
    while (true) {
        reloadRequested = false;
        const data = await presetApi.list();
        snapshot = Object.freeze(data || {});
        loaded = true;
        if (!reloadRequested) break;
    }

    if (pendingNotify) {
        const detail = pendingDetail;
        pendingNotify = false;
        pendingDetail = {};
        notify(detail);
    }
    return snapshot;
}

export async function loadPresets({ force = false, notifyListeners = false, detail = {} } = {}) {
    if (loaded && !force && !reloadPromise) return snapshot;

    if (notifyListeners) {
        pendingNotify = true;
        pendingDetail = detail;
    }
    if (reloadPromise) {
        if (force) reloadRequested = true;
        return reloadPromise;
    }

    reloadPromise = runReloads().finally(() => {
        reloadPromise = null;
    });
    return reloadPromise;
}

async function refreshFromEvent(detail) {
    try {
        await loadPresets({ force: true, notifyListeners: true, detail });
    } catch (error) {
        console.error("Could not refresh presets", error);
    }
}

function startEvents() {
    if (!resyncHandler && typeof window !== "undefined") {
        resyncHandler = () => {
            if (document.visibilityState !== "visible") return;
            clearTimeout(resyncTimer);
            resyncTimer = setTimeout(() => refreshFromEvent({ action: "resync" }), 150);
        };
        document.addEventListener("visibilitychange", resyncHandler);
        window.addEventListener("focus", resyncHandler);
        window.addEventListener("online", resyncHandler);
    }
    if (eventSource || typeof EventSource === "undefined") return;
    eventSource = new EventSource(`${presetApi.base}/events`);
    eventSource.addEventListener("presets-changed", event => {
        let detail = {};
        try { detail = JSON.parse(event.data || "{}"); } catch (_) {}
        refreshFromEvent(detail);
    });
    eventSource.addEventListener("ready", event => {
        let detail = { action: "ready" };
        try { detail = { action: "ready", ...JSON.parse(event.data || "{}") }; } catch (_) {}
        refreshFromEvent(detail);
    });
}

function stopEvents() {
    if (listeners.size) return;
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    if (resyncHandler && typeof window !== "undefined") {
        document.removeEventListener("visibilitychange", resyncHandler);
        window.removeEventListener("focus", resyncHandler);
        window.removeEventListener("online", resyncHandler);
        resyncHandler = null;
        clearTimeout(resyncTimer);
        resyncTimer = null;
    }
}

export function subscribePresets(listener) {
    listeners.add(listener);
    startEvents();
    return () => {
        listeners.delete(listener);
        stopEvents();
    };
}
