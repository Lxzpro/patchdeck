import type { CurrentRunStatus, Issue, PR, PRStatus } from "@shared/schema";
import type { StatusTone } from "@/lib/statusTones";

export function formatPRWorkState(status: PRStatus, prStage?: PR["prStage"]): string {
  if (status === "processing") {
    if (prStage === "feedback_synced") return "反馈已同步";
    if (prStage === "triaged") return "已评估";
    if (prStage === "applying") return "正在应用修复";
    if (prStage === "tests") return "正在验证检查";
    if (prStage === "done") return "处理完成";
    return "自动化运行中";
  }

  if (status === "done") return "处理完成";
  if (status === "error") return "需要关注";
  if (status === "archived") return "已归档";
  return "监控中";
}

export function prWorkStateTone(status: PRStatus): StatusTone {
  if (status === "error") return "destructive";
  if (status === "processing") return "primary";
  if (status === "archived") return "success";
  return "neutral";
}

export function formatCurrentRunStatus(status: CurrentRunStatus["status"]): string {
  if (status === "completed") return "运行完成";
  return { queued: "排队中", running: "运行中", failed: "失败" }[status];
}

export function formatIssueWorkStage(issue: Pick<Issue, "workStage" | "workStatus">): string {
  const stage = issue.workStage ?? (
    issue.workStatus === "in_progress" ? "working" : issue.workStatus
  );

  if (stage === "completed") return "处理完成";
  return {
    idle: "空闲",
    queued: "排队中",
    started: "已启动",
    working: "处理中",
    verifying: "验证中",
    opening_pr: "正在创建 PR",
    failed: "失败",
  }[stage];
}

export function formatIssueAutoWorkState(
  issue: Pick<Issue, "autoWorkEligible" | "autoWorkBlockedReason">,
): string {
  if (issue.autoWorkEligible) return "可以处理";
  return issue.autoWorkBlockedReason ?? "仅手动";
}

export function autoWorkStateTone(eligible: boolean | undefined): StatusTone {
  return eligible ? "primary" : "neutral";
}
