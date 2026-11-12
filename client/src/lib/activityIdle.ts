import type { ActivitySnapshot } from "@shared/schema";

export type ActivityIdleReasonInput = {
  activities: Pick<ActivitySnapshot, "inProgress" | "queued">;
  drainMode?: boolean;
  drainReason?: string | null;
  githubRateLimited?: boolean;
  githubRateLimitResetAt?: string | null;
  autoEnabled?: boolean;
  trackedLabel?: string;
  trackedCount?: number;
  eligibleCount?: number;
};

function formatResetTime(resetAt: string | null | undefined): string | null {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("zh-CN");
}

function pluralize(count: number, label: string): string {
  const labels: Record<string, string> = { item: "项任务", PR: "个 PR", issue: "个议题" };
  return `${count} ${labels[label] ?? label}`;
}

export function getActivityIdleReason(input: ActivityIdleReasonInput): string | null {
  if (input.activities.inProgress.length > 0 || input.activities.queued.length > 0) {
    return null;
  }

  if (input.drainMode) {
    return input.drainReason
      ? `排空模式已暂停自动化：${input.drainReason}`
      : "排空模式已暂停自动化。";
  }

  if (input.githubRateLimited) {
    const resetTime = formatResetTime(input.githubRateLimitResetAt);
    return resetTime
      ? `GitHub 请求已限流，将于 ${resetTime} 后继续处理。`
      : "GitHub 请求已限流，额度恢复后将继续处理。";
  }

  if (input.autoEnabled === false) {
    return "自动化已设为手动模式。";
  }

  const trackedCount = input.trackedCount ?? 0;
  const trackedLabel = input.trackedLabel ?? "item";
  const eligibleCount = input.eligibleCount ?? 0;

  if (eligibleCount > 0) {
    return `当前没有运行中的任务，${pluralize(eligibleCount, trackedLabel)} 可在有空闲执行名额时加入队列。`;
  }

  if (trackedCount > 0) {
    return `当前没有运行中的任务，已跟踪 ${pluralize(trackedCount, trackedLabel)}，但暂无符合条件的任务，或正在等待下次同步。`;
  }

  return "尚未跟踪任何任务。";
}
