"use strict";

(function exposeStatusSync(root) {
  function applyStatusChanges(remote, pending) {
    const merged = { ...remote };
    for (const [url, change] of Object.entries(pending)) {
      if (change.status === "new") delete merged[url];
      else merged[url] = { status: change.status, at: change.at };
    }
    return merged;
  }

  function removeSyncedChanges(pending, snapshot) {
    const remaining = { ...pending };
    for (const [url, change] of Object.entries(snapshot)) {
      if (JSON.stringify(remaining[url]) === JSON.stringify(change)) delete remaining[url];
    }
    return remaining;
  }

  function parsePendingStatuses(raw) {
    try {
      const parsed = JSON.parse(raw || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  const api = { applyStatusChanges, removeSyncedChanges, parsePendingStatuses };
  root.StatusSync = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
