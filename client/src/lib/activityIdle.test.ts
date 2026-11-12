import test from "node:test";
import assert from "node:assert/strict";
import type { ActivitySnapshot } from "@shared/schema";
import { getActivityIdleReason } from "./activityIdle";

const emptyActivities: Pick<ActivitySnapshot, "inProgress" | "queued"> = {
  inProgress: [],
  queued: [],
};

test("getActivityIdleReason returns null while work is running", () => {
  assert.equal(getActivityIdleReason({
    activities: {
      ...emptyActivities,
      inProgress: [{} as ActivitySnapshot["inProgress"][number]],
    },
  }), null);
});

test("getActivityIdleReason explains drain mode before generic idleness", () => {
  assert.equal(getActivityIdleReason({
    activities: emptyActivities,
    drainMode: true,
    drainReason: "operator paused",
    trackedCount: 12,
    trackedLabel: "PR",
  }), "排空模式已暂停自动化：operator paused");
});

test("getActivityIdleReason explains rate limits with reset time", () => {
  const reason = getActivityIdleReason({
    activities: emptyActivities,
    githubRateLimited: true,
    githubRateLimitResetAt: "2026-05-17T16:30:00.000Z",
  });

  assert.match(reason ?? "", /GitHub 请求已限流/);
  assert.match(reason ?? "", /后继续处理/);
});

test("getActivityIdleReason explains eligible tracked work", () => {
  assert.equal(getActivityIdleReason({
    activities: emptyActivities,
    trackedCount: 20,
    eligibleCount: 3,
    trackedLabel: "PR",
  }), "当前没有运行中的任务，3 个 PR 可在有空闲执行名额时加入队列。");
});

test("getActivityIdleReason explains tracked work with no known eligible items", () => {
  assert.equal(getActivityIdleReason({
    activities: emptyActivities,
    trackedCount: 20,
    eligibleCount: 0,
    trackedLabel: "issue",
  }), "当前没有运行中的任务，已跟踪 20 个议题，但暂无符合条件的任务，或正在等待下次同步。");
});
