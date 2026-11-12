import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeState } from "@shared/schema";
import {
  getDrainActionLabel,
  getDrainStatusView,
} from "./runtimeDisplay";

const activeRuntimeState: RuntimeState = {
  drainMode: false,
  drainRequestedAt: null,
  drainReason: null,
};

test("getDrainStatusView shows loading before runtime state is available", () => {
  assert.deepEqual(getDrainStatusView(undefined, false), {
    label: "正在加载…",
    className: "text-muted-foreground",
  });
});

test("getDrainStatusView shows an error when runtime state fails to load", () => {
  assert.deepEqual(getDrainStatusView(undefined, true), {
    label: "无法获取",
    className: "text-destructive",
  });
});

test("getDrainStatusView shows active and paused runtime states", () => {
  assert.deepEqual(getDrainStatusView(activeRuntimeState, false), {
    label: "运行中",
    className: "text-muted-foreground",
  });
  assert.deepEqual(getDrainStatusView({ ...activeRuntimeState, drainMode: true }, false), {
    label: "已暂停",
    className: "text-destructive",
  });
});

test("getDrainActionLabel returns capitalized action labels", () => {
  assert.equal(getDrainActionLabel(undefined), "暂停");
  assert.equal(getDrainActionLabel(activeRuntimeState), "暂停");
  assert.equal(getDrainActionLabel({ ...activeRuntimeState, drainMode: true }), "恢复");
});
