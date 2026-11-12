import test from "node:test";
import assert from "node:assert/strict";
import { autoWorkStateTone, formatCurrentRunStatus, formatIssueAutoWorkState, formatIssueWorkStage, formatPRWorkState, prWorkStateTone } from "./statusCopy";

test("formatPRWorkState separates run completion from merge readiness", () => {
  assert.equal(formatPRWorkState("done"), "处理完成");
  assert.equal(formatPRWorkState("processing", "tests"), "正在验证检查");
  assert.equal(prWorkStateTone("done"), "neutral");
});

test("formatCurrentRunStatus keeps completed runs neutral in copy", () => {
  assert.equal(formatCurrentRunStatus("completed"), "运行完成");
  assert.equal(formatCurrentRunStatus("running"), "运行中");
});

test("issue auto-work copy says ready to work instead of auto eligible", () => {
  assert.equal(formatIssueAutoWorkState({ autoWorkEligible: true, autoWorkBlockedReason: null }), "可以处理");
  assert.equal(formatIssueAutoWorkState({ autoWorkEligible: false, autoWorkBlockedReason: "blocked label" }), "blocked label");
  assert.equal(autoWorkStateTone(true), "primary");
});

test("formatIssueWorkStage names completed issue work as work finished", () => {
  assert.equal(formatIssueWorkStage({ workStage: "completed", workStatus: "idle" }), "处理完成");
});
