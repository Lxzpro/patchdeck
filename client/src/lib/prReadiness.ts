import type { PR, PRSummary } from "@shared/schema";
import { arePRFeedbackItemsResolved } from "@/lib/feedbackStatus";

export type PRReadinessCheck = {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type PRReadinessWorkStatus = {
  label: string;
  detail: string | null;
} | null;

export function isGitHubReadyToMerge(pr: Pick<PRSummary, "mergeableState">): boolean {
  return pr.mergeableState === "clean";
}

export function isPRSummaryReadyToMerge(
  pr: Pick<PRSummary, "status" | "testsPassed" | "lintPassed" | "mergeableState">,
): boolean {
  return pr.status !== "processing"
    && pr.status !== "error"
    && pr.status !== "archived"
    && pr.testsPassed !== false
    && pr.lintPassed !== false
    && isGitHubReadyToMerge(pr);
}

export function isPRDetailReadyToMerge(
  pr: Pick<PR, "status" | "testsPassed" | "lintPassed" | "mergeableState" | "feedbackItems">,
): boolean {
  return pr.status !== "processing"
    && pr.status !== "error"
    && pr.status !== "archived"
    && pr.testsPassed !== false
    && pr.lintPassed !== false
    && isGitHubReadyToMerge(pr)
    && arePRFeedbackItemsResolved(pr.feedbackItems);
}

export function buildPRReadinessChecks(
  pr: Pick<PR, "status" | "testsPassed" | "lintPassed" | "mergeableState" | "feedbackItems">,
  workStatus: PRReadinessWorkStatus = null,
): PRReadinessCheck[] {
  const feedbackResolved = arePRFeedbackItemsResolved(pr.feedbackItems);
  const unresolvedCount = pr.feedbackItems.filter((item) =>
    item.status !== "resolved" && item.status !== "rejected"
  ).length;
  const workActive = pr.status === "processing" || workStatus !== null;

  return [
    {
      key: "work-state",
      label: workStatus?.label === "运行中"
        ? "自动化运行中"
        : workStatus
          ? "自动化排队中"
          : "自动化空闲",
      passed: !workActive,
      detail: workStatus
        ? workStatus.detail ?? "处理任务已加入队列。"
        : pr.status === "processing" ? "处理任务仍在运行。" : "没有运行中的处理任务。",
    },
    {
      key: "tests",
      label: "测试通过",
      passed: pr.testsPassed !== false && isGitHubReadyToMerge(pr),
      detail: pr.testsPassed === true
        ? "最新测试已通过。"
        : pr.testsPassed === false
          ? "最新测试失败。"
          : pr.mergeableState === "clean"
            ? "GitHub 显示必需检查已通过。"
            : "尚未同步测试结果。",
    },
    {
      key: "lint",
      label: "代码检查通过",
      passed: pr.lintPassed !== false,
      detail: pr.lintPassed === true
        ? "最新代码检查已通过。"
        : pr.lintPassed === false
          ? "最新代码检查失败。"
          : "尚未同步独立的代码检查结果。",
    },
    {
      key: "comments",
      label: "反馈已处理",
      passed: feedbackResolved,
      detail: feedbackResolved
        ? "所有跟踪的评审反馈均已解决或拒绝。"
        : `仍有 ${unresolvedCount} 条反馈需要处理。`,
    },
    {
      key: "github",
      label: "GitHub 可合并状态",
      passed: isGitHubReadyToMerge(pr),
      detail: pr.mergeableState === "clean"
        ? "GitHub 显示此 PR 可以合并。"
        : `GitHub 合并状态：${pr.mergeableState ?? "未知"}。`,
    },
  ];
}
