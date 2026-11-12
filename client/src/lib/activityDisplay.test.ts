import assert from "node:assert/strict";
import test from "node:test";
import { formatActivityDetail, formatActivityLabel } from "./activityDisplay";

test("formatActivityLabel updates legacy PR work labels", () => {
  assert.equal(formatActivityLabel("Babysitting PR #6097"), "处理 PR #6097");
  assert.equal(formatActivityLabel("Working PR #6097"), "处理 PR #6097");
});

test("formatActivityDetail updates legacy deferred queue copy", () => {
  assert.equal(
    formatActivityDetail("Refilling babysitter queue after the active batch drains"),
    "补充 PR 处理队列 after the active batch drains",
  );
  assert.equal(formatActivityDetail(null), null);
});

test("activity labels translate task prefixes and preserve repository names", () => {
  assert.equal(formatActivityLabel("Working issue owner/repo#42"), "处理议题 owner/repo#42");
  assert.equal(formatActivityLabel("Sync watched repositories"), "同步关注的仓库");
  assert.equal(formatActivityLabel("Custom diagnostic"), "Custom diagnostic");
});
