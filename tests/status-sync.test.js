"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyStatusChanges,
  removeSyncedChanges,
  parsePendingStatuses,
} = require("../status-sync.js");

test("applies additions and deletions over remote state", () => {
  const remote = {
    a: { status: "applied", at: "old" },
    b: { status: "skipped", at: "old" },
  };
  const pending = {
    a: { status: "new", at: "1" },
    c: { status: "applied", at: "2" },
  };
  assert.deepEqual(applyStatusChanges(remote, pending), {
    b: { status: "skipped", at: "old" },
    c: { status: "applied", at: "2" },
  });
});

test("clears only unchanged entries from the synchronized snapshot", () => {
  const snapshot = { a: { status: "applied", at: "1" } };
  const pending = {
    a: { status: "skipped", at: "2" },
    b: { status: "applied", at: "3" },
  };
  assert.deepEqual(removeSyncedChanges(pending, snapshot), pending);
  assert.deepEqual(
    removeSyncedChanges({ ...snapshot, b: pending.b }, snapshot),
    { b: pending.b },
  );
});

test("invalid local storage data falls back to an empty queue", () => {
  assert.deepEqual(parsePendingStatuses("{bad"), {});
  assert.deepEqual(parsePendingStatuses("[]"), {});
});
