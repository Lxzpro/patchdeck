import { formatStatusLabel } from "@/lib/displayLabels";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Collapsible from "@radix-ui/react-collapsible";
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronUp, CircleDashed, Loader2, PanelRightClose, PanelRightOpen, Pause, Play, PlayCircle, RefreshCw } from "lucide-react";
import { queryClient, apiRequest, fetchJson } from "@/lib/queryClient";
import type { ActivityItem, ActivitySnapshot, Config, FeedbackItem, HealingSession, Issue, IssueListPage, LogEntry, OperatorWarning, PR, PRQuestion, PRSummary, PRWorkContract, RuntimeState, WatchedRepo } from "@shared/schema";

import { AppHeader } from "@/components/AppHeader";
import { OnboardingPanel } from "@/components/OnboardingPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { ActivityMenu, EMPTY_ACTIVITY_SNAPSHOT } from "@/components/ActivityMenu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import {
  formatFeedbackStatusLabel,
  getFeedbackStatusBadgeClass,
  isFeedbackCollapsedByDefault,
  countActiveFeedbackStatuses,
} from "@/lib/feedbackStatus";
import {
  buildPRReadinessChecks,
  isPRDetailReadyToMerge,
  isPRSummaryReadyToMerge,
} from "@/lib/prReadiness";
import {
  getHealingSessionView,
  selectRelevantHealingSession,
} from "@/lib/ciHealing";
import { buildQueueStatusIndex, type QueueStatusView } from "@/lib/activityQueue";
import { QueueStatusBadge } from "@/components/QueueStatusBadge";
import { CurrentRunStatusStrip } from "@/components/CurrentRunStatusStrip";
import { DashboardErrorsPanel } from "@/components/DashboardErrorsPanel";
import { GlobalActivityPanel } from "@/components/GlobalActivityPanel";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailHeader } from "@/components/detail/DetailHeader";
import { MetaBreadcrumb, type MetaItem } from "@/components/detail/MetaBreadcrumb";
import { StageProgressBar } from "@/components/detail/StageProgressBar";
import { StatusChip } from "@/components/detail/StatusChip";
import { buildPRStages } from "@/lib/stages";
import { prStatusTone, toneRailClass } from "@/lib/statusTones";
import { ACTIVITY_POLL_INTERVAL_MS, getUiPollIntervalMs } from "@/lib/polling";
import { getActivityIdleReason } from "@/lib/activityIdle";
import { formatPRWorkState } from "@/lib/statusCopy";
import { PR_LIST_STALE_MS, readCachedPRs, writeCachedPRs } from "@/lib/prListCache";
import { getSafePRWorkContract } from "@/lib/prWorkContractView";

type GitHubRateLimitState = {
  limited: boolean;
  resetAt: string | null;
  recentlyLimited?: boolean;
};

function formatClock(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }

  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatContractTime(timestamp: string | null): string | null {
  const clock = formatClock(timestamp);
  return clock ? `${clock}` : null;
}

function formatGitHubUsername(username?: string | null): string {
  const normalized = username?.trim().replace(/^@/, "");
  return normalized ? `@${normalized}` : "@unknown";
}

function isPRWatchEnabled(pr: Pick<PRSummary, "watchEnabled">): boolean {
  return pr.watchEnabled;
}

function normalizeNumberSearch(value: string): string {
  return value.trim().replace(/^#/, "").trim();
}

function matchesNumberSearch(number: number, search: string): boolean {
  const normalized = normalizeNumberSearch(search);
  return normalized === "" || String(number).includes(normalized);
}

function prIssueLinkKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

type PrStatusFilter = "all" | "ready" | "ci_failing" | "attention" | "processing" | "done";

function matchesPrStatusFilter(pr: PRSummary, filter: PrStatusFilter): boolean {
  switch (filter) {
    case "ready":
      return isPRSummaryReadyToMerge(pr);
    case "ci_failing":
      return pr.testsPassed === false || pr.lintPassed === false;
    case "attention":
      return pr.flagged > 0 || pr.status === "error";
    case "processing":
      return pr.status === "processing";
    case "done":
      return pr.status === "done";
    case "all":
      return true;
  }
}

const PR_STATUS_FILTERS: { value: PrStatusFilter; label: string; testId: string }[] = [
  { value: "ready", label: "可以合并", testId: "pr-ready-filter" },
  { value: "ci_failing", label: "CI 失败", testId: "pr-ci-failing-filter" },
  { value: "attention", label: "需要关注", testId: "pr-attention-filter" },
  { value: "processing", label: "运行中", testId: "pr-processing-filter" },
  { value: "done", label: "处理完成", testId: "pr-done-filter" },
];

function FilterChip({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`rounded-md border px-2 py-0.5 text-label uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function buildIssueLinkedPRIndex(issues: Issue[]): Map<string, Issue> {
  const index = new Map<string, Issue>();
  for (const issue of issues) {
    if (issue.workPrNumber === null || issue.workPrNumber === undefined) {
      continue;
    }

    index.set(prIssueLinkKey(issue.repo, issue.workPrNumber), issue);
  }
  return index;
}

function latestActivityForTarget(activities: ActivityItem[], targetId: string): ActivityItem | undefined {
  return activities.reduce((latest, activity) => {
    if (activity.targetId !== targetId) {
      return latest;
    }
    if (!latest || Date.parse(activity.updatedAt) > Date.parse(latest.updatedAt)) {
      return activity;
    }
    return latest;
  }, undefined as ActivityItem | undefined);
}

function parseIssueTargetId(targetId: string): { repo: string; number: number } | null {
  const separator = targetId.lastIndexOf("#");
  if (separator === -1) {
    return null;
  }

  const repo = targetId.slice(0, separator);
  const number = Number(targetId.slice(separator + 1));
  if (!repo || !Number.isInteger(number) || number <= 0) {
    return null;
  }

  return { repo, number };
}

function scrollToDashboardErrors() {
  document.getElementById("dashboard-errors")?.scrollIntoView({ block: "start" });
}

function getPRFeedbackFailureReason(pr: PR | PRSummary | null): string | null {
  if (!pr || !("feedbackItems" in pr)) {
    return null;
  }

  const failedItem = pr.feedbackItems.find((item) =>
    (item.status === "failed" || item.status === "warning") && Boolean(item.statusReason),
  );

  return failedItem?.statusReason ?? null;
}

const MAX_VISIBLE_LOGS = 200;
const DRAIN_PAUSED_LABEL = "已暂停";
const DRAIN_PAUSED_TITLE = "已因排空模式暂停";
const MANUAL_RUNS_BLOCKED_COPY = "全局自动化暂停期间，手动任务也不可运行。";
const GLOBAL_DRAIN_PR_COPY = "排空模式已暂停后台和手动任务。";
const ASK_DRAIN_COPY = "排空模式已暂停代理问答。";

const HEALING_TONE_CLASSES: Record<"neutral" | "info" | "warning" | "success" | "danger", string> = {
  neutral: "border-border text-muted-foreground",
  info: "border-primary bg-primary/10 text-primary",
  warning: "border-warning-border bg-warning-muted text-warning-foreground",
  success: "border-success-border bg-success-muted text-success-foreground",
  danger: "border-destructive bg-destructive/10 text-destructive",
};

function FeedbackStatusTag({ status }: { status: FeedbackItem["status"] }) {
  const cls = getFeedbackStatusBadgeClass(status);
  return (
    <span className={`inline-block border px-1.5 py-0 text-label uppercase tracking-wide ${cls}`}>
      {formatFeedbackStatusLabel(status)}
    </span>
  );
}

function WatchPausedIndicator() {
  return (
    <span className="border border-border px-1.5 py-0 text-label uppercase tracking-wider text-muted-foreground">
      监控已暂停
    </span>
  );
}

function DashboardDrainBanner({ runtimeState }: { runtimeState: RuntimeState | undefined }) {
  if (!runtimeState?.drainMode) {
    return null;
  }

  return (
    <div
      className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-body"
      data-testid="dashboard-drain-banner"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-label font-medium uppercase tracking-wider text-destructive">
            {DRAIN_PAUSED_TITLE}
          </div>
          {runtimeState.drainReason ? (
            <div
              className="mt-1 break-words text-foreground/80"
              data-testid="dashboard-drain-reason"
            >
              {runtimeState.drainReason}
            </div>
          ) : null}
          <div className="mt-1 text-label text-muted-foreground">
            {MANUAL_RUNS_BLOCKED_COPY}
          </div>
        </div>
        <Link
          href="/settings"
          className="shrink-0 border border-destructive/50 px-2 py-0.5 text-label uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          设置
        </Link>
      </div>
    </div>
  );
}

function OperatorWarningsBanner({ warnings }: { warnings: OperatorWarning[] }) {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <div
      className="shrink-0 border-b border-yellow-600/50 bg-yellow-500/10 px-4 py-3"
      data-testid="operator-warnings-banner"
    >
      <div className="space-y-3">
        {warnings.map((warning) => (
          <div key={warning.id} data-testid={`operator-warning-${warning.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-body font-medium uppercase tracking-wider text-yellow-600">
                {warning.title}
              </div>
              {warning.targetUrl && (
                <a
                  href={warning.targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border border-yellow-600/60 px-2 py-0.5 text-label uppercase tracking-wider text-yellow-600 transition-colors hover:bg-yellow-600 hover:text-background"
                >
                  打开 PR
                </a>
              )}
            </div>
            <div className="mt-1 text-body text-foreground/80">{warning.message}</div>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-label text-muted-foreground">
              {warning.fixSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReadyToMergeIndicator({
  href,
  testId,
  label,
  hint,
  className,
  dotClassName,
  hintClassName,
  onClick,
}: {
  href: string;
  testId: string;
  label: string;
  hint?: string;
  className: string;
  dotClassName: string;
  hintClassName?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex items-center rounded-md border border-success-border bg-success-muted font-medium uppercase text-success-foreground transition-colors hover:bg-success-muted/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${className}`}
    >
      <span className={`inline-block rounded-full bg-success ${dotClassName}`} />
      {label}
      {hint && <span className={hintClassName}>{hint}</span>}
    </a>
  );
}

function MergeReadinessChecklist({
  checks,
  ready,
  contract,
}: {
  checks: ReturnType<typeof buildPRReadinessChecks>;
  ready: boolean;
  contract: PRWorkContract;
}) {
  const nextAction = formatContractTime(contract.nextActionAt);
  return (
    <div
      className={`mt-2 rounded-md border px-3 py-2 text-label ${
        ready
          ? "border-success-border bg-success-muted text-success-foreground"
          : "border-warning-border bg-warning-muted text-warning-foreground"
      }`}
      data-testid="pr-merge-readiness-checklist"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-label font-medium uppercase tracking-wider">
          合并就绪状态
        </div>
        <div className="rounded-md border border-current/40 px-1.5 py-0 text-label uppercase tracking-wider">
          {ready ? "ready" : "尚未就绪"}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-current/20 pt-2 text-label">
        <span className="font-medium uppercase tracking-wider text-foreground">处理约定</span>
        <span>
          意图： <span className="text-foreground">{formatStatusLabel(contract.intent)}</span>
        </span>
        <span>
          阶段： <span className="text-foreground">{formatStatusLabel(contract.phase)}</span>
        </span>
        {contract.blocker && (
          <span>
            原因： <span className="text-foreground">{formatStatusLabel(contract.blocker ?? "无")}</span>
          </span>
        )}
        {nextAction && (
          <span>
            下一步： <span className="font-mono text-foreground">{nextAction}</span>
          </span>
        )}
        {contract.reason && (
          <span className="min-w-0 flex-1 truncate" title={contract.reason}>
            {contract.reason}
          </span>
        )}
      </div>
      <div className="mt-2 grid gap-1 sm:grid-cols-2">
        {checks.map((check) => (
          <div key={check.key} className="flex min-w-0 items-start gap-1.5" data-testid="pr-readiness-check">
            {check.passed ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0">
              <span className="block text-label font-medium text-foreground">{check.label}</span>
              <span className="block truncate text-label opacity-80" title={check.detail}>
                {check.detail}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AutomationStatusPanel({
  pr,
  contract,
  queueStatus,
  failedActivity,
  watchEnabled,
  globalDrainMode,
  isGitHubThrottled,
  activityIdleReason,
  errorMessage,
}: {
  pr: PR;
  contract: PRWorkContract;
  queueStatus: QueueStatusView | null;
  failedActivity?: ActivityItem;
  watchEnabled: boolean;
  globalDrainMode: boolean;
  isGitHubThrottled: boolean;
  activityIdleReason: string | null;
  errorMessage: string | null;
}) {
  const nextAction = formatContractTime(contract.nextActionAt);
  const lastAttempt = formatContractTime(contract.lastAttemptAt);
  const currentRun = pr.currentRun;
  const statusLabel = queueStatus?.label
    ?? (currentRun?.status === "running" ? "运行中" : null)
    ?? (globalDrainMode ? "已暂停" : null)
    ?? (!watchEnabled ? "监控已暂停" : null)
    ?? (isGitHubThrottled ? "已限流" : null)
    ?? (pr.status === "error" ? "需要关注" : "监控中");
  const reason = errorMessage
    ?? failedActivity?.lastError
    ?? contract.reason
    ?? activityIdleReason
    ?? "没有阻塞原因记录。";

  return (
    <div
      className="mt-2 rounded-md border border-border bg-background/60 px-3 py-2 text-label"
      data-testid="pr-automation-status-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-label font-medium uppercase tracking-wider text-muted-foreground">
          自动化状态
        </div>
        <span className="rounded-md border border-border px-1.5 py-0 text-label uppercase tracking-wider text-foreground">
          {statusLabel}
        </span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-label uppercase tracking-wider text-muted-foreground">阶段</div>
          <div className="mt-0.5 text-foreground">{formatStatusLabel(contract.phase)}</div>
        </div>
        <div>
          <div className="text-label uppercase tracking-wider text-muted-foreground">队列</div>
          <div className="mt-0.5">
            {queueStatus ? <QueueStatusBadge status={queueStatus} /> : <span className="text-foreground">没有排队任务</span>}
          </div>
        </div>
        <div>
          <div className="text-label uppercase tracking-wider text-muted-foreground">下一步操作</div>
          <div className="mt-0.5 text-foreground">{nextAction ?? "等待监控程序"}</div>
        </div>
        <div>
          <div className="text-label uppercase tracking-wider text-muted-foreground">上次尝试</div>
          <div className="mt-0.5 text-foreground">{lastAttempt ?? "暂无记录"}</div>
        </div>
      </div>
      <div className="mt-2 border-t border-border pt-2">
        <span className="text-label uppercase tracking-wider text-muted-foreground">原因</span>
        <span className="ml-2 text-foreground/80">
          {contract.blocker ? `${formatStatusLabel(contract.blocker ?? "无")}: ` : ""}
          {reason}
        </span>
      </div>
    </div>
  );
}

function AgentIndicator({ pr }: { pr: PRSummary }) {
  const isProcessing = pr.status === "processing";

  if (!isProcessing) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 cursor-default items-center gap-1 text-body text-primary"
          data-testid={`agent-indicator-${pr.id}`}
        >
          <Bot className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-body">代理正在处理此 PR</p>
      </TooltipContent>
    </Tooltip>
  );
}

function PRRowSkeleton() {
  return (
    <div className="border-b border-l-2 border-l-transparent border-border px-4 py-3">
      <div className="flex items-start gap-3">
        <Skeleton className="mt-1.5 h-2 w-2 rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
          <div className="mt-2 ml-[3.75rem] flex items-center gap-3">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-2.5 w-14" />
          </div>
        </div>
      </div>
    </div>
  );
}

const PRRow = memo(function PRRow({
  pr,
  isSelected,
  onSelect,
  failureMessage,
  queueStatus,
  issueLink,
}: {
  pr: PRSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
  failureMessage?: string | null;
  queueStatus: QueueStatusView | null;
  issueLink?: Issue | null;
}) {
  const checkedAt = formatClock(pr.lastChecked);
  const watchEnabled = isPRWatchEnabled(pr);
  const workContract = getSafePRWorkContract(pr.workContract);
  const railTone = isPRSummaryReadyToMerge(pr) ? "success" : prStatusTone(pr);
  return (
    <div
      onClick={() => onSelect(pr.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(pr.id);
        }
      }}
      role="button"
      tabIndex={0}
      data-testid={`pr-row-${pr.id}`}
      className={`w-full cursor-pointer border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
        isSelected
          ? `border-l-[3px] ${toneRailClass(railTone)} bg-muted`
          : `border-l-2 ${toneRailClass(railTone)}`
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="w-12 shrink-0 font-mono text-body text-muted-foreground">#{pr.number}</span>
            <span className="truncate">{pr.title}</span>
            <AgentIndicator pr={pr} />
            {issueLink && (
              <span
                data-testid="pr-on-issues-badge"
                className="shrink-0 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0 text-label uppercase tracking-wider text-primary"
                title={`关联自议题 #${issueLink.number}`}
              >
                议题 <span className="font-mono">#{issueLink.number}</span>
              </span>
            )}
          </div>
          {pr.status === "error" && failureMessage && (
            <div className="mt-2 ml-[3.75rem] border border-destructive/40 bg-destructive/10 px-2 py-1 text-label leading-4 text-destructive">
              <span className="font-medium uppercase tracking-wider">错误：</span>{" "}
              <span className="break-words">{failureMessage}</span>
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[3.75rem] text-label text-muted-foreground">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="underline decoration-border underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              {pr.repo}
            </a>
            <span>{formatGitHubUsername(pr.author)}</span>
            <span>{formatPRWorkState(pr.status, pr.prStage)}</span>
            {workContract.blocker && (
              <span title={workContract.reason ?? undefined}>
                原因： {formatStatusLabel(workContract.blocker ?? "无")}
              </span>
            )}
            <QueueStatusBadge status={queueStatus} />
            {!watchEnabled && <WatchPausedIndicator />}
            <span>{pr.accepted + pr.rejected + pr.flagged} 已评估</span>
            {checkedAt && <span>已检查 {checkedAt}</span>}
          </div>
        </div>
      </div>
    </div>
  );
});

function isTrustedAuthor(author: string, trustedReviewers: readonly string[] | undefined): boolean {
  if (!author || !trustedReviewers || trustedReviewers.length === 0) return false;
  const normalized = author.trim().toLowerCase().replace(/^@/, "");
  return trustedReviewers.some((entry) => entry.trim().toLowerCase().replace(/^@/, "") === normalized);
}

function FeedbackRow({
  item,
  prId,
  readOnly,
  globalDrainMode = false,
}: {
  item: FeedbackItem;
  prId: string;
  readOnly?: boolean;
  globalDrainMode?: boolean;
}) {
  const overrideMutation = useMutation({
    mutationFn: async (decision: string) => {
      const res = await apiRequest("PATCH", `/api/prs/${prId}/feedback/${item.id}`, { decision });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs", prId] });
    },
  });

  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/prs/${prId}/feedback/${item.id}/retry`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs", prId] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (error) => {
      showMutationError("无法重试反馈处理", error);
    },
  });

  const createdAt = formatClock(item.createdAt);
  const collapsedByDefault = isFeedbackCollapsedByDefault(item.status);
  const prominentStatusReason = (item.status === "failed" || item.status === "warning") && item.statusReason
    ? item.statusReason
    : null;
  const { data: config } = useQuery<Config>({ queryKey: ["/api/config"] });
  const trusted = isTrustedAuthor(item.author, config?.trustedReviewers);

  return (
    <Collapsible.Root defaultOpen={!collapsedByDefault} className="border-b border-border">
      <div className="px-4 py-3">
        {/* Header row - always visible */}
        <div className="flex items-start gap-3">
          <div className="shrink-0 pt-0.5">
            <FeedbackStatusTag status={item.status} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-medium">{item.author}</span>
              {trusted && (
                <span
                  className="rounded-md border border-success-border bg-success-muted px-1.5 py-0 text-label font-medium uppercase tracking-wider text-success-foreground"
                  title={`@${item.author} 是可信评审者，反馈已自动接受，跳过代理评估。`}
                  data-testid={`feedback-trusted-${item.id}`}
                >
                  可信评审者
                </span>
              )}
              {item.file && (
                <span className="font-mono text-label text-muted-foreground">
                  {item.file}{item.line ? `:${item.line}` : ""}
                </span>
              )}
              <span className="text-label text-muted-foreground">{formatStatusLabel(item.type)}</span>
              {createdAt && <span className="text-label text-muted-foreground">{createdAt}</span>}
            </div>
            {prominentStatusReason && (
              <div className="mt-1 whitespace-pre-wrap break-words border border-destructive/30 bg-destructive/10 px-2 py-1 text-label leading-4 text-destructive">
                <span className="font-medium uppercase tracking-wider">失败原因：</span>{" "}
                {prominentStatusReason}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!readOnly && (item.status === "failed" || item.status === "warning") && (
              <button
                type="button"
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending || globalDrainMode}
                data-testid={`retry-${item.id}`}
                aria-label={`重试 ${item.author} 的反馈`}
                title={globalDrainMode ? DRAIN_PAUSED_TITLE : "重试反馈处理"}
                className="border border-border px-2 py-0.5 text-label uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
              >
                {globalDrainMode ? DRAIN_PAUSED_LABEL : "重试"}
              </button>
            )}
            <Collapsible.Trigger asChild>
              <button
                type="button"
                data-testid={`toggle-${item.id}`}
                aria-label={`${collapsedByDefault ? "显示" : "隐藏"} ${item.author} 的反馈详情`}
                title="展开或收起反馈详情"
                className="border border-border px-2 py-0.5 text-label uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                详情
              </button>
            </Collapsible.Trigger>
            {!readOnly && (["accept", "reject", "flag"] as const).map((decision) => {
              const selected = item.decision === decision;
              const selectedClass =
                decision === "accept"
                  ? "border-success-border bg-success-muted text-success-foreground"
                  : decision === "reject"
                    ? "border-destructive bg-destructive/10 text-destructive"
                    : "border-warning-border bg-warning-muted text-warning-foreground";
              return (
                <button
                  type="button"
                  key={decision}
                  onClick={() => overrideMutation.mutate(decision)}
                  data-testid={`override-${decision}-${item.id}`}
                  aria-label={`${{ accept: "接受", reject: "拒绝", flag: "标记" }[decision]} ${item.author} 的反馈`}
                  aria-pressed={selected}
                  className={`cursor-pointer rounded-md border px-2 py-0.5 text-label uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                    selected ? selectedClass : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {decision}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <Collapsible.Content>
        <div className="px-4 pb-3">
          {item.bodyHtml ? (
            <div
              className="feedback-markdown text-body leading-relaxed"
              dangerouslySetInnerHTML={{ __html: item.bodyHtml }}
            />
          ) : (
            <p className="whitespace-pre-wrap text-body leading-relaxed text-foreground/80">{item.body}</p>
          )}
          {item.statusReason && !prominentStatusReason && (
            <p className="mt-2 whitespace-pre-wrap break-words text-label text-muted-foreground">
              <span className="font-medium uppercase tracking-wider text-foreground/70">状态原因：</span>{" "}
              {item.statusReason}
            </p>
          )}
          {item.decisionReason && (
            <p className="mt-2 whitespace-pre-wrap break-words text-label text-muted-foreground">
              <span className="font-medium uppercase tracking-wider text-foreground/70">决策原因：</span>{" "}
              {item.decisionReason}
            </p>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function LogPanel({ prId }: { prId: string | null }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [clearedLogIds, setClearedLogIds] = useState<Set<string>>(() => new Set());
  const { data: logs = [] } = useQuery<LogEntry[]>({
    queryKey: ["/api/logs", prId ?? "all"],
    queryFn: async () => {
      if (!prId) {
        return [];
      }
      const url = `/api/logs?prId=${encodeURIComponent(prId)}`;
      const res = await apiRequest("GET", url);
      return res.json();
    },
    enabled: Boolean(prId),
    refetchInterval: 1500,
  });
  const viewLogs = useMemo(
    () => logs.filter((log) => !clearedLogIds.has(log.id)),
    [clearedLogIds, logs],
  );
  const visibleLogs = useMemo(
    () => viewLogs.length > MAX_VISIBLE_LOGS ? viewLogs.slice(-MAX_VISIBLE_LOGS) : viewLogs,
    [viewLogs],
  );
  const hiddenLogCount = viewLogs.length - visibleLogs.length;
  useEffect(() => {
    setClearedLogIds(new Set());
  }, [prId]);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    scroller.scrollTop = scroller.scrollHeight;
  }, [visibleLogs.length, prId]);

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto" data-testid="pr-detail-logs">
        {!prId ? (
          <div className="p-4 text-body text-muted-foreground">选择 PR 以查看日志。</div>
        ) : logs.length === 0 ? (
          <div className="p-4 text-body text-muted-foreground">暂无工作流日志。</div>
        ) : viewLogs.length === 0 ? (
          <div className="p-4 text-body text-muted-foreground">
            视图已清空，新日志会显示在此处。
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
              <span className="text-label uppercase tracking-wider text-muted-foreground">
                {viewLogs.length} 可见
              </span>
              <button
                type="button"
                onClick={() => setClearedLogIds(new Set(logs.map((log) => log.id)))}
                className="cursor-pointer rounded-md border border-border bg-transparent px-2 py-0.5 text-label font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                清空视图
              </button>
            </div>
            {hiddenLogCount > 0 && (
              <div className="border-b border-border/60 px-3 py-2 text-label uppercase tracking-wider text-muted-foreground">
                显示最近 {MAX_VISIBLE_LOGS} 条记录。
              </div>
            )}
            {visibleLogs.map((log) => {
              const metadataText = log.metadata && Object.keys(log.metadata).length > 0
                ? JSON.stringify(log.metadata, null, 2)
                : null;

              return (
                <div key={log.id} className="border-b border-border/60 px-3 py-2 last:border-b-0" data-testid={`log-${log.id}`}>
                  <div className="flex flex-wrap items-center gap-2 text-label uppercase tracking-wider text-muted-foreground">
                    <span className={
                      log.level === "error" ? "text-destructive" :
                      log.level === "warn" ? "text-warning-foreground" :
                      log.level === "info" ? "text-primary" :
                      "text-muted-foreground"
                    }>
                      {log.level}
                    </span>
                    {log.phase && <span className="border border-border px-1 py-0">{log.phase}</span>}
                    {log.runId && <span className="normal-case text-foreground/45">运行 {log.runId.slice(0, 8)}</span>}
                    <span>{formatClock(log.timestamp)}</span>
                  </div>
                  <div className={`mt-1 break-words text-body ${log.level === "error" ? "text-destructive" : "text-foreground/75"}`}>
                    {log.message}
                  </div>
                  {metadataText && (
                    <pre className="mt-1 whitespace-pre-wrap break-all text-label text-muted-foreground">
                      {metadataText}
                    </pre>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function HealingPanel({
  pr,
  config,
  healingSessions,
}: {
  pr: PR;
  config: Config | undefined;
  healingSessions: HealingSession[];
}) {
  const session = selectRelevantHealingSession(healingSessions, pr.id);
  const view = session ? getHealingSessionView(session, config) : null;
  const toneClass = view ? HEALING_TONE_CLASSES[view.tone] : HEALING_TONE_CLASSES.neutral;

  return (
    <div
      className="shrink-0 border-b border-border px-4 py-3"
      data-testid="panel-ci-healing"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-label font-medium uppercase tracking-wider text-muted-foreground">CI 自动修复</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {view ? (
              <>
                <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-label font-medium uppercase tracking-wider ${toneClass}`}>
                  {view.stateLabel}
                </span>
                <span className="text-label text-muted-foreground">{view.attemptSummary}</span>
              </>
            ) : (
              <span className="text-label text-muted-foreground">
                {config?.autoHealCI === false
                  ? "设置中已关闭 CI 自动修复。"
                  : "此 PR 暂无修复会话。"}
              </span>
            )}
          </div>
        </div>
        {session && (
          <span className="shrink-0 font-mono text-label text-muted-foreground">
            当前提交 {session.currentHeadSha.slice(0, 7)}
          </span>
        )}
      </div>

      {view ? (
        <>
          <div className="mt-2 grid gap-1 text-label">
            {view.reasonSummary && (
              <div>
                <span className="text-label uppercase tracking-wider text-muted-foreground">原因</span>
                <span className="ml-2 text-foreground/80">{view.reasonSummary}</span>
              </div>
            )}
            <div className="text-muted-foreground">{view.statusHint}</div>
            <div>
              <span className="text-label uppercase tracking-wider text-muted-foreground">尝试次数</span>
              <span className="ml-2 font-mono text-foreground/80">{view.attemptSummary}</span>
              {session?.latestFingerprint && (
                <>
                  <span className="mx-1.5 text-border" aria-hidden="true">·</span>
                  <span className="text-label uppercase tracking-wider text-muted-foreground">故障特征</span>
                  <span className="ml-1.5 font-mono text-foreground/80">{session.latestFingerprint}</span>
                </>
              )}
            </div>
          </div>
          {view.actions.length > 0 && (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                {view.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    disabled
                    title={action.hint}
                    className={`rounded-md border px-2 py-0.5 text-label uppercase tracking-wider transition-colors ${
                      action.available
                        ? "border-border text-foreground/70 hover:bg-muted"
                        : "border-border text-muted-foreground/60"
                    } disabled:opacity-100`}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-label text-muted-foreground">
                修复操作接口尚未接入，当前控件仅供查看。
              </div>
            </>
          )}
        </>
      ) : (
        config?.autoHealCI !== false && (
          <div className="mt-2 text-label text-muted-foreground">
            监控程序将检查失败判定为可修复后，会创建修复会话。
          </div>
        )
      )}
    </div>
  );
}

function PRDescriptionPanel({ pr }: { pr: PR }) {
  const [isOpen, setIsOpen] = useState(false);
  if (!pr.body && !pr.bodyHtml) return null;
  return (
    <div className="shrink-0 border-b border-border px-4 py-3" data-testid="panel-pr-description">
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <div className="text-label font-medium uppercase tracking-wider text-muted-foreground">描述</div>
        {isOpen ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {isOpen && (
        pr.bodyHtml ? (
          <article
            data-testid="pr-body-markdown"
            className="issue-markdown mt-2 border border-border/60 bg-background p-4"
            dangerouslySetInnerHTML={{ __html: pr.bodyHtml }}
          />
        ) : (
          <pre className="mt-2 whitespace-pre-wrap break-words border border-border/60 bg-background p-4 text-body leading-6 text-muted-foreground">
            {pr.body?.trim() || "暂无描述。"}
          </pre>
        )
      )}
    </div>
  );
}

// Expanded activity rail: viewport-bounded below `lg`, a fixed side column above it.
const PR_ACTIVITY_PANEL_CLASS = "max-h-[42dvh] min-h-0 w-full shrink-0 flex-col border-t border-border lg:max-h-none lg:min-h-0 lg:w-64 xl:w-80 lg:border-l lg:border-t-0";

function RightPanel({
  prId,
  activities,
  queueStatusById,
  isCollapsed,
  onToggleCollapsed,
  idleReason,
  mobileHidden = false,
}: {
  prId: string | null;
  activities: ActivitySnapshot;
  queueStatusById: Map<string, QueueStatusView>;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  idleReason?: string | null;
  /** Hidden below `lg` while the single-pane layout is showing the PR list. */
  mobileHidden?: boolean;
}) {
  const mobileVisibility = mobileHidden ? "hidden lg:flex" : "flex";

  if (isCollapsed) {
    return (
      <div className={`${mobileVisibility} h-10 w-full shrink-0 items-center justify-end border-t border-border px-2 lg:h-auto lg:w-10 lg:flex-col lg:justify-start lg:border-l lg:border-t-0 lg:px-0 lg:py-2`} data-testid="activity-panel-collapsed">
        <button
          type="button"
          onClick={onToggleCollapsed}
          data-testid="button-toggle-activity-panel"
          title="展开活动"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">展开活动</span>
        </button>
      </div>
    );
  }

  return (
    <div className={`${mobileVisibility} ${PR_ACTIVITY_PANEL_CLASS}`}>
      <div className="flex shrink-0 items-center border-b border-border">
        <div
          className="flex-1 bg-muted px-3 py-2 text-label uppercase tracking-wider text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
          data-testid="tab-activity"
        >
          活动
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          data-testid="button-toggle-activity-panel"
          title="收起活动"
          className="mr-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">收起活动</span>
        </button>
      </div>
      <GlobalActivityPanel activities={activities} queueStatusById={queueStatusById} idleReason={idleReason} />
      <div className="flex-1 overflow-hidden">
        <LogPanel prId={prId} />
      </div>
    </div>
  );
}

function QAPanel({ prId, globalDrainMode }: { prId: string; globalDrainMode: boolean }) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: questions = [] } = useQuery<PRQuestion[]>({
    queryKey: ["/api/prs", prId, "questions"],
    refetchInterval: 2000,
  });

  const askMutation = useMutation({
    mutationFn: (question: string) =>
      apiRequest("POST", `/api/prs/${prId}/questions`, { question }).then((res) => res.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs", prId, "questions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      setInput("");
    },
  });

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [questions.length, questions[questions.length - 1]?.status]);

  const askDisabled = askMutation.isPending || !input.trim() || globalDrainMode;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-label uppercase tracking-wider text-muted-foreground">
        询问代理
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {questions.length === 0 ? (
          <span className="text-body text-muted-foreground">
            {globalDrainMode
              ? ASK_DRAIN_COPY
              : "可就此 PR 提问，代理会读取活动日志、反馈和状态后回答。"}
          </span>
        ) : (
          questions.map((q) => (
            <div key={q.id} className="space-y-1.5" data-testid={`question-${q.id}`}>
              <div className="text-body">
                <span className="font-medium text-foreground/90">问： </span>
                <span className="text-foreground/80">{q.question}</span>
              </div>
              {q.status === "pending" || q.status === "answering" ? (
                <div className="text-label text-muted-foreground animate-pulse">
                  代理正在思考…
                </div>
              ) : q.status === "error" ? (
                <div className="text-label text-destructive">
                  错误： {q.error || "未知错误"}
                </div>
              ) : (
                <div className="text-body leading-relaxed text-foreground/85 whitespace-pre-wrap border-l-2 border-primary/40 pl-3">
                  {q.answer}
                </div>
              )}
              <div className="text-label text-muted-foreground">
                {formatClock(q.createdAt)}
                {q.answeredAt && ` — 回答于 ${formatClock(q.answeredAt)}`}
              </div>
            </div>
          ))
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!askDisabled) askMutation.mutate(input.trim());
        }}
        className="border-t border-border p-3"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={globalDrainMode ? "排空模式已开启。" : "评审完成了吗？为什么失败了？"}
            aria-label="关于所选 PR 的问题"
            disabled={globalDrainMode}
            data-testid="input-question"
            className="flex-1 border border-border bg-transparent px-2 py-1 text-body placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
          <button
            type="submit"
            disabled={askDisabled}
            title={globalDrainMode ? DRAIN_PAUSED_TITLE : "询问代理"}
            data-testid="button-ask"
            className="cursor-pointer border border-primary bg-primary px-3 py-1 text-label font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
          >
            {globalDrainMode ? DRAIN_PAUSED_LABEL : askMutation.isPending ? "..." : "提问"}
          </button>
        </div>
        {askMutation.isError && (
          <div className="mt-1 text-label text-destructive">
            {getErrorMessage(askMutation.error)}
          </div>
        )}
      </form>
    </div>
  );
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const raw = error.message.replace(/^\d+:\s*/, "").trim();
  if (!raw) {
    return "请求失败";
  }

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Keep the original message when the server did not return JSON.
  }

  return raw;
}

function showMutationError(title: string, error: unknown) {
  toast({
    variant: "destructive",
    title,
    description: getErrorMessage(error),
  });
}

export default function Dashboard() {
  const [selectedPRId, setSelectedPRId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"active" | "issues" | "archived">("active");
  const [prNumberSearch, setPrNumberSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string>("all");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<PrStatusFilter>("all");
  // Failed jobs start rolled up on narrow viewports so they cannot swallow the pane.
  const [areErrorsRolledUp, setAreErrorsRolledUp] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAskOpen, setIsAskOpen] = useState(false);
  // Activity starts collapsed on narrow viewports so the PR body owns the pane.
  const [isActivityPanelCollapsed, setIsActivityPanelCollapsed] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );
  // Below `lg` the list and the detail share the viewport one pane at a time.
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [areMobileFiltersOpen, setAreMobileFiltersOpen] = useState(false);
  const selectPR = useCallback((prId: string) => {
    setSelectedPRId(prId);
    setMobilePane("detail");
  }, []);

  const handleSyncDashboard = async () => {
    setIsRefreshing(true);
    try {
      await apiRequest("POST", "/api/repos/sync?scope=prs");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/prs"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/prs/archived"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/activities"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/healing-sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/runtime"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] }),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
    refetchInterval: 5000,
  });
  const uiPollIntervalMs = getUiPollIntervalMs(config);
  const cachedActivePRs = useMemo(() => readCachedPRs("active"), []);
  const cachedArchivedPRs = useMemo(() => readCachedPRs("archived"), []);

  const activePRsQuery = useQuery<PRSummary[]>({
    queryKey: ["/api/prs"],
    initialData: cachedActivePRs?.data,
    initialDataUpdatedAt: cachedActivePRs?.updatedAt,
    staleTime: PR_LIST_STALE_MS,
    refetchInterval: 3000,
  });

  const archivedPRsQuery = useQuery<PRSummary[]>({
    queryKey: ["/api/prs/archived"],
    initialData: cachedArchivedPRs?.data,
    initialDataUpdatedAt: cachedArchivedPRs?.updatedAt,
    staleTime: PR_LIST_STALE_MS,
    refetchInterval: 10000,
  });
  const { data: prs = [], isLoading } = activePRsQuery;
  const { data: archivedPRs = [], isLoading: isLoadingArchived } = archivedPRsQuery;

  useEffect(() => {
    if (activePRsQuery.status === "success") {
      writeCachedPRs("active", activePRsQuery.data);
    }
  }, [activePRsQuery.status, activePRsQuery.data]);

  useEffect(() => {
    if (archivedPRsQuery.status === "success") {
      writeCachedPRs("archived", archivedPRsQuery.data);
    }
  }, [archivedPRsQuery.status, archivedPRsQuery.data]);

  const { data: runtimeState } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 3000,
  });
  const { data: githubRateLimit } = useQuery<GitHubRateLimitState>({
    queryKey: ["/api/github-rate-limit"],
    refetchInterval: uiPollIntervalMs,
  });
  const globalDrainMode = runtimeState?.drainMode === true;
  const isGitHubThrottled = githubRateLimit?.limited === true;
  const throttledTitle = githubRateLimit?.resetAt
    ? `GitHub 请求已限流，将于 ${new Date(githubRateLimit.resetAt).toLocaleTimeString("zh-CN")} 恢复`
    : "GitHub 请求已限流";

  const { data: issuesPage, isLoading: isLoadingIssues } = useQuery<IssueListPage>({
    queryKey: ["/api/issues"],
    enabled: runtimeState !== undefined && !globalDrainMode,
    refetchInterval: uiPollIntervalMs,
  });
  const issues = issuesPage?.items ?? [];

  const { data: healingSessions = [] } = useQuery<HealingSession[]>({
    queryKey: ["/api/healing-sessions"],
    queryFn: async () => fetchJson<HealingSession[]>("/api/healing-sessions"),
    refetchInterval: 5000,
  });

  const { data: activities = EMPTY_ACTIVITY_SNAPSHOT } = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activities"],
    refetchInterval: ACTIVITY_POLL_INTERVAL_MS,
  });
  const queueStatusById = useMemo(() => buildQueueStatusIndex(activities), [activities]);

  const { data: repos = [] } = useQuery<WatchedRepo[]>({
    queryKey: ["/api/repos/settings"],
    refetchInterval: 5000,
  });

  const issueLinkedPRByKey = useMemo(() => buildIssueLinkedPRIndex(issues), [issues]);
  const issueLinkedPRs = useMemo(
    () => prs.filter((pr) => issueLinkedPRByKey.has(prIssueLinkKey(pr.repo, pr.number))),
    [prs, issueLinkedPRByKey],
  );
  const viewPRs = viewMode === "archived"
    ? archivedPRs
    : viewMode === "issues"
      ? issueLinkedPRs
      : prs;
  const repoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pr of viewPRs) {
      counts.set(pr.repo, (counts.get(pr.repo) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [viewPRs]);
  const statusCounts = useMemo(() => {
    const counts: Record<PrStatusFilter, number> = {
      all: viewPRs.length,
      ready: 0,
      ci_failing: 0,
      attention: 0,
      processing: 0,
      done: 0,
    };
    for (const pr of viewPRs) {
      for (const { value } of PR_STATUS_FILTERS) {
        if (matchesPrStatusFilter(pr, value)) {
          counts[value] += 1;
        }
      }
    }
    return counts;
  }, [viewPRs]);
  const displayedPRs = viewPRs
    .filter((pr) => matchesNumberSearch(pr.number, prNumberSearch))
    .filter((pr) => selectedRepo === "all" || pr.repo === selectedRepo)
    .filter((pr) => matchesPrStatusFilter(pr, selectedStatusFilter))
    .sort((a, b) => b.number - a.number);
  const isArchived = viewMode === "archived";
  const normalizedPrNumberSearch = normalizeNumberSearch(prNumberSearch);
  const isLoadingCurrentView = isArchived ? isLoadingArchived : viewMode === "issues" ? isLoading || isLoadingIssues : isLoading;
  const selectedPRSummary = displayedPRs.find((pr) => pr.id === selectedPRId) ?? null;
  const { data: selectedPRDetail } = useQuery<PR | null>({
    queryKey: ["/api/prs", selectedPRId],
    enabled: selectedPRId !== null,
    queryFn: async () => {
      if (!selectedPRId) return null;
      return fetchJson<PR>(`/api/prs/${selectedPRId}`);
    },
    refetchInterval: 3000,
  });

  useEffect(() => {
    // Switching tabs changes the available repos/statuses; reset filters so a
    // stale selection doesn't leave the list looking empty.
    setSelectedRepo("all");
    setSelectedStatusFilter("all");
  }, [viewMode]);

  useEffect(() => {
    if (displayedPRs.length === 0) {
      if (selectedPRId !== null) {
        setSelectedPRId(null);
      }
      return;
    }

    if (!selectedPRId || !displayedPRs.some((pr) => pr.id === selectedPRId)) {
      setSelectedPRId(displayedPRs[0].id);
    }
  }, [displayedPRs, selectedPRId]);

  const selectedPR = selectedPRDetail ?? null;
  const selectedPRWatchEnabled = selectedPRSummary ? isPRWatchEnabled(selectedPRSummary) : true;
  const selectedFailedActivity = selectedPRSummary ? latestActivityForTarget(activities.failed, selectedPRSummary.id) : undefined;
  const selectedPRQueueStatus = selectedPRSummary ? queueStatusById.get(selectedPRSummary.id) ?? null : null;
  const selectedPRWorkContract = selectedPR ? getSafePRWorkContract(selectedPR.workContract) : null;
  const selectedPRErrorMessage = selectedPRSummary?.status === "error" && !selectedPRQueueStatus
    ? selectedFailedActivity?.lastError ?? getPRFeedbackFailureReason(selectedPR) ?? "此 PR 的自动化已停止，请查看活动日志了解失败详情。"
    : null;
  const activeErrorCount = activities.failed.length + activities.warnings.length;
  const eligiblePRCount = prs.filter((pr) =>
    pr.watchEnabled
    && pr.status !== "processing"
    && pr.status !== "archived"
    && !isPRSummaryReadyToMerge(pr)
  ).length;
  const activityIdleReason = getActivityIdleReason({
    activities,
    drainMode: globalDrainMode,
    drainReason: runtimeState?.drainReason ?? null,
    githubRateLimited: isGitHubThrottled,
    githubRateLimitResetAt: githubRateLimit?.resetAt ?? null,
    autoEnabled: config?.autoPrs !== false,
    trackedCount: prs.length,
    eligibleCount: eligiblePRCount,
    trackedLabel: "PR",
  });
  const selectedPRReadinessChecks = selectedPR ? buildPRReadinessChecks(selectedPR, selectedPRQueueStatus) : [];

  const applyMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/prs/${id}/apply`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
      toast({ description: "已将 PR 处理任务加入队列。" });
    },
    onError: (error) => {
      showMutationError("无法将 PR 任务加入队列", error);
    },
  });

  const watchMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await apiRequest("PATCH", `/api/prs/${id}/watch`, { enabled });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs/archived"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (error) => {
      showMutationError("无法更新 PR 监控状态", error);
    },
  });
  const syncPrMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/prs/${id}/fetch`);
      return res.json() as Promise<PR>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs/archived"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
      toast({ description: "PR 同步完成。" });
    },
    onError: (error) => {
      showMutationError("无法同步 PR", error);
    },
  });

  const clearFailedActivitiesMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/activities/failed");
      return res.json() as Promise<{ cleared: number }>;
    },
    onSuccess: ({ cleared }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      toast({ description: cleared === 1 ? "已清除 1 条失败活动。" : `已清除 ${cleared} 条失败活动。` });
    },
    onError: (error) => {
      showMutationError("无法清除失败活动", error);
    },
  });

  const clearIssueFailureMutation = useMutation({
    mutationFn: async (activity: ActivityItem) => {
      const issueTarget = parseIssueTargetId(activity.targetId);
      if (!issueTarget) {
        throw new Error(`无法解析议题标识 ${activity.targetId}`);
      }

      const res = await apiRequest("DELETE", "/api/issues/work/failures", issueTarget);
      return res.json() as Promise<{ repo: string; number: number; id: string }>;
    },
    onSuccess: (issue) => {
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/issues/detail", issue.repo, issue.number] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs", issue.id] });
      toast({ description: `已清除 #${issue.number} 的失败处理记录。` });
    },
    onError: (error) => {
      showMutationError("无法清除议题失败记录", error);
    },
  });
  const selectedPRWorkButtonLabel = (() => {
    if (globalDrainMode) return DRAIN_PAUSED_LABEL;
    if (applyMutation.isPending) return "正在排队";
    if (selectedPRQueueStatus?.label === "运行中" || selectedPR?.status === "processing") return "运行中";
    if (selectedPRQueueStatus) return "已加入队列";
    return "加入处理队列";
  })();

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <UpdateBanner />
      <AppHeader
        active="prs"
        status={(
          <span>
            <span className="font-mono text-foreground">{prs.length}</span> PR / <span className="font-mono text-foreground">{repos.length}</span> 仓库
          </span>
        )}
        actions={(
          <>

            {activeErrorCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setAreErrorsRolledUp(false);
                  scrollToDashboardErrors();
                }}
                data-testid="dashboard-error-pill"
                className="inline-flex items-center gap-1 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-label uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                错误
                <span className="font-mono">{activeErrorCount}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => { void handleSyncDashboard(); }}
              disabled={isRefreshing || globalDrainMode || isGitHubThrottled}
              title={isGitHubThrottled ? throttledTitle : undefined}
              data-testid="button-sync-dashboard"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-label uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
            >
              {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              同步
            </button>
            <ActivityMenu
              activities={activities}
              onClearFailed={() => clearFailedActivitiesMutation.mutate()}
              isClearingFailed={clearFailedActivitiesMutation.isPending}
              globalDrainMode={globalDrainMode}
              queueStatusById={queueStatusById}
              pollIntervalMs={ACTIVITY_POLL_INTERVAL_MS}
              idleReason={activityIdleReason}
            />
          </>
        )}
      />

      <OnboardingPanel />
      <OperatorWarningsBanner warnings={activities.warnings} />
      <DashboardErrorsPanel
        activities={activities}
        onClearFailed={() => clearFailedActivitiesMutation.mutate()}
        isClearingFailed={clearFailedActivitiesMutation.isPending}
        onClearIssueFailure={(activity) => clearIssueFailureMutation.mutate(activity)}
        isClearingIssueFailure={clearIssueFailureMutation.isPending}
        rolledUp={areErrorsRolledUp}
        onToggleRolledUp={() => setAreErrorsRolledUp((current) => !current)}
      />
      <DashboardDrainBanner runtimeState={runtimeState} />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div
          data-testid="pr-list-pane"
          className={`${mobilePane === "detail" ? "hidden lg:flex" : "flex"} min-h-0 w-full flex-col overflow-hidden border-b border-border lg:w-[20rem] xl:w-[28rem] 2xl:w-[30rem] lg:shrink-0 lg:border-b-0 lg:border-r`}
        >
          <div className="sticky top-0 z-10 flex shrink-0 border-b border-border bg-background">
            <button
              type="button"
              onClick={() => setViewMode("active")}
              data-testid="tab-active"
              className={`flex-1 whitespace-nowrap px-2 py-2 text-label uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
                viewMode === "active"
                  ? "bg-muted text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              进行中（{prs.length}）
            </button>
            <button
              type="button"
              onClick={() => setViewMode("issues")}
              data-testid="tab-on-issues"
              className={`flex-1 whitespace-nowrap px-2 py-2 text-label uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
                viewMode === "issues"
                  ? "bg-muted text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              关联议题（{issueLinkedPRs.length}）
            </button>
            <button
              type="button"
              onClick={() => setViewMode("archived")}
              data-testid="tab-archived"
              className={`flex-1 whitespace-nowrap px-2 py-2 text-label uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
                viewMode === "archived"
                  ? "bg-muted text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              已归档（{archivedPRs.length}）
            </button>
          </div>
          <div className="flex shrink-0 items-center justify-end border-b border-border px-3 py-1.5 lg:hidden">
            <button
              type="button"
              onClick={() => setAreMobileFiltersOpen((open) => !open)}
              aria-expanded={areMobileFiltersOpen}
              aria-controls="pr-filter-bar"
              data-testid="button-toggle-pr-filters"
              className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-label uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              {areMobileFiltersOpen ? <ChevronUp className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
              筛选
            </button>
          </div>
          <div
            id="pr-filter-bar"
            data-testid="pr-filter-bar"
            className={`${areMobileFiltersOpen ? "flex" : "hidden"} max-h-[50dvh] shrink-0 flex-col gap-2 overflow-y-auto border-b border-border px-3 py-2 lg:flex lg:max-h-none lg:overflow-visible`}
          >
            <div>
              <label htmlFor="pr-number-search" className="sr-only">搜索 PR 编号</label>
              <input
                id="pr-number-search"
                value={prNumberSearch}
                onChange={(event) => setPrNumberSearch(event.target.value)}
                placeholder="搜索编号"
                data-testid="pr-number-search"
                className="h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-body text-foreground placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <span className="mt-1 w-14 shrink-0 text-label font-medium uppercase tracking-wider text-muted-foreground">
                仓库
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                <FilterChip active={selectedRepo === "all"} onClick={() => setSelectedRepo("all")}>
                  全部（{viewPRs.length}）
                </FilterChip>
                {repoCounts.map(([repo, count]) => (
                  <FilterChip
                    key={repo}
                    active={selectedRepo === repo}
                    onClick={() => setSelectedRepo(repo)}
                  >
                    {repo} ({count})
                  </FilterChip>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <span className="mt-1 w-14 shrink-0 text-label font-medium uppercase tracking-wider text-muted-foreground">
                状态
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {PR_STATUS_FILTERS.map((filter) => (
                  <FilterChip
                    key={filter.value}
                    active={selectedStatusFilter === filter.value}
                    onClick={() => setSelectedStatusFilter(filter.value)}
                    testId={filter.testId}
                  >
                    {filter.label} ({statusCounts[filter.value]})
                  </FilterChip>
                ))}
                <FilterChip
                  active={selectedStatusFilter === "all"}
                  onClick={() => setSelectedStatusFilter("all")}
                >
                  所有状态
                </FilterChip>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoadingCurrentView ? (
              <div data-testid="pr-list-loading" aria-label="正在加载 PR">
                {Array.from({ length: 6 }).map((_, idx) => (
                  <PRRowSkeleton key={idx} />
                ))}
              </div>
            ) : displayedPRs.length === 0 ? (
              <div className="p-4 text-body text-muted-foreground">
                {normalizedPrNumberSearch
                  ? `没有匹配 #${normalizedPrNumberSearch} 的 PR。`
                  : isArchived
                    ? "暂无已归档 PR，关闭的 PR 会自动归档。"
                    : viewMode === "issues"
                      ? "暂无从议题关联的活动 PR。"
                  : "尚未跟踪 PR，请在设置中添加仓库或 PR。"}
              </div>
            ) : (
              displayedPRs.map((pr) => (
                <PRRow
                  key={pr.id}
                  pr={pr}
                  isSelected={pr.id === selectedPRId}
                  onSelect={selectPR}
                  queueStatus={queueStatusById.get(pr.id) ?? null}
                  issueLink={issueLinkedPRByKey.get(prIssueLinkKey(pr.repo, pr.number)) ?? null}
                  failureMessage={
                    pr.status === "error" && !queueStatusById.get(pr.id)
                      ? latestActivityForTarget(activities.failed, pr.id)?.lastError ?? getPRFeedbackFailureReason(pr)
                      : null
                  }
                />
              ))
            )}
          </div>
        </div>

        <div
          data-testid="pr-detail-pane"
          className={`${mobilePane === "list" ? "hidden lg:flex" : "flex"} min-h-0 flex-1 flex-col overflow-hidden lg:min-h-[32rem]`}
        >
          {selectedPR ? (
            <>
              {(() => {
                const selectedPRFailed = selectedPR.status === "error" && !selectedPRQueueStatus;
                const metaItems: MetaItem[] = [
                  { key: "status", content: <span>处理状态： <span className="text-foreground">{formatPRWorkState(selectedPR.status, selectedPR.prStage)}</span></span> },
                  { key: "author", content: <span>作者： <span className="text-foreground/80">{formatGitHubUsername(selectedPR.author)}</span></span> },
                  { key: "items", content: <span><span className="font-mono text-foreground">{selectedPR.feedbackItems.length}</span> 条反馈</span> },
                ];
                if (selectedPRQueueStatus) {
                  metaItems.push({ key: "queue", content: <QueueStatusBadge status={selectedPRQueueStatus} /> });
                }
                if (selectedPR.feedbackItems.length > 0) {
                  const counts = countActiveFeedbackStatuses(selectedPR.feedbackItems);
                  if (counts.queued > 0) metaItems.push({ key: "fb-queued", content: <span className="text-primary"><span className="font-mono">{counts.queued}</span> 排队中</span> });
                  if (counts.inProgress > 0) metaItems.push({ key: "fb-inprogress", content: <span className="text-primary"><span className="font-mono">{counts.inProgress}</span> 处理中</span> });
                  if (counts.failed > 0) metaItems.push({ key: "fb-failed", content: <span className="text-destructive"><span className="font-mono">{counts.failed}</span> 失败</span> });
                  if (counts.warning > 0) metaItems.push({ key: "fb-warning", content: <span className="text-warning-foreground"><span className="font-mono">{counts.warning}</span> 警告</span> });
                }
                if (selectedPR.testsPassed !== null) {
                  metaItems.push({ key: "tests", content: <span>测试： <span className={selectedPR.testsPassed ? "text-success" : "text-destructive"}>{selectedPR.testsPassed ? "通过" : "失败"}</span></span> });
                }
                if (selectedPR.lintPassed !== null) {
                  metaItems.push({ key: "lint", content: <span>代码检查： <span className={selectedPR.lintPassed ? "text-success" : "text-destructive"}>{selectedPR.lintPassed ? "通过" : "失败"}</span></span> });
                }
                if (selectedPR.lastChecked) {
                  metaItems.push({ key: "checked", content: <span>已检查 <span className="font-mono">{formatClock(selectedPR.lastChecked)}</span></span> });
                }
                if (selectedPR.lastSyncSucceededAt) {
                  metaItems.push({ key: "synced", content: <span>已同步 <span className="font-mono">{formatClock(selectedPR.lastSyncSucceededAt)}</span></span> });
                }
                if (selectedPR.lastSyncError) {
                  metaItems.push({ key: "sync-error", content: <span className="text-destructive">同步错误</span> });
                }
                return (
              <DetailHeader
                title={selectedPR.title}
                onBack={() => setMobilePane("list")}
                backLabel="所有 PR"
                accentTone="primary"
                failed={selectedPRFailed}
                stageBar={<StageProgressBar stages={buildPRStages(selectedPR)} testId="pr-stage-progress" />}
                titleSuffix={(
                  <>
                    <AgentIndicator pr={selectedPR} />
                    {!selectedPRWatchEnabled && <WatchPausedIndicator />}
                    <StatusChip tone={prStatusTone(selectedPR)} pulsing={selectedPR.status === "processing"} label={formatPRWorkState(selectedPR.status, selectedPR.prStage)} />
                  </>
                )}
                externalLink={{ href: selectedPR.url, label: `${selectedPR.repo}#${selectedPR.number}` }}
                meta={<MetaBreadcrumb items={metaItems} />}
                actions={!isArchived ? (
                  <>
                    <button
                      type="button"
                      onClick={() => syncPrMutation.mutate(selectedPR.id)}
                      disabled={syncPrMutation.isPending || globalDrainMode || isGitHubThrottled}
                      title={
                        globalDrainMode
                          ? DRAIN_PAUSED_TITLE
                          : isGitHubThrottled
                            ? throttledTitle
                            : "立即同步 GitHub 反馈"
                      }
                      data-testid="button-sync-pr"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-label font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {syncPrMutation.isPending ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" />正在同步</>
                      ) : (
                        <><RefreshCw className="h-3.5 w-3.5" />同步</>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => watchMutation.mutate({ id: selectedPR.id, enabled: !selectedPRWatchEnabled })}
                      disabled={watchMutation.isPending}
                      data-testid="button-toggle-watch"
                      title={selectedPRWatchEnabled ? "暂停此 PR 的后台监控" : "恢复此 PR 的后台监控"}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-label font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {selectedPRWatchEnabled ? (
                        <><Pause className="h-3.5 w-3.5" />暂停监控</>
                      ) : (
                        <><Play className="h-3.5 w-3.5" />恢复监控</>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => applyMutation.mutate(selectedPR.id)}
                      disabled={applyMutation.isPending || selectedPR.status === "processing" || Boolean(selectedPRQueueStatus) || globalDrainMode || isGitHubThrottled}
                      title={
                        globalDrainMode
                          ? DRAIN_PAUSED_TITLE
                          : isGitHubThrottled
                            ? throttledTitle
                            : "将 PR 任务加入处理队列"
                      }
                      data-testid="button-apply"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-primary bg-primary px-2.5 py-0.5 text-label font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {applyMutation.isPending || selectedPR.status === "processing" || selectedPRQueueStatus ? (
                        <>
                          {(applyMutation.isPending || selectedPR.status === "processing" || selectedPRQueueStatus?.label === "运行中") ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CircleDashed className="h-3.5 w-3.5" />
                          )}
                          {selectedPRWorkButtonLabel}
                        </>
                      ) : (
                        <><PlayCircle className="h-3.5 w-3.5" />{selectedPRWorkButtonLabel}</>
                      )}
                    </button>
                  </>
                ) : undefined}
	                banner={(
	                  <>
	                    <CurrentRunStatusStrip run={selectedPR.currentRun} testId="selected-pr-current-run" />
	                    <AutomationStatusPanel
	                      pr={selectedPR}
	                      contract={selectedPRWorkContract ?? getSafePRWorkContract(null)}
	                      queueStatus={selectedPRQueueStatus}
	                      failedActivity={selectedFailedActivity}
	                      watchEnabled={selectedPRWatchEnabled}
	                      globalDrainMode={globalDrainMode}
	                      isGitHubThrottled={isGitHubThrottled}
	                      activityIdleReason={activityIdleReason}
	                      errorMessage={selectedPRErrorMessage}
	                    />
	                    <MergeReadinessChecklist
	                      checks={selectedPRReadinessChecks}
                      ready={isPRDetailReadyToMerge(selectedPR)}
                      contract={selectedPRWorkContract ?? getSafePRWorkContract(null)}
                    />
                    {isPRDetailReadyToMerge(selectedPR) && (
                      <ReadyToMergeIndicator
                        href={selectedPR.url}
                        testId="detail-ready-to-merge"
                        label="GitHub 显示可以合并"
                        hint="在 GitHub 上打开 PR →"
                        className="mt-2 gap-2 px-3 py-1.5 text-body tracking-wider"
                        dotClassName="h-2 w-2"
                        hintClassName="text-label normal-case tracking-normal text-success-foreground/75"
                      />
                    )}
                    {selectedPRErrorMessage && (
                      <div
                        className="mt-2 border border-destructive/40 bg-destructive/10 px-3 py-2 text-body leading-5 text-destructive"
                        data-testid="selected-pr-error"
                      >
                        <div className="text-label font-medium uppercase tracking-wider">自动化错误</div>
                        <div className="mt-1 whitespace-pre-wrap break-words">{selectedPRErrorMessage}</div>
                      </div>
                    )}
                    <div className="mt-2 text-label text-muted-foreground">
                      {globalDrainMode
                        ? GLOBAL_DRAIN_PR_COPY
                        : selectedPRWatchEnabled
                          ? "后台监控会同步 GitHub 反馈，并自动推送已批准的修复。"
                          : "此 PR 的后台监控已暂停，仍可手动运行。"}
                    </div>
                  </>
                )}
              />
                );
              })()}

              <HealingPanel pr={selectedPR} config={config} healingSessions={healingSessions} />
              <PRDescriptionPanel pr={selectedPR} />

          <div className="flex-1 overflow-y-auto">
                {selectedPR.feedbackItems.length === 0 ? (
                  <div className="p-4 text-body text-muted-foreground">
                    {selectedPRWatchEnabled
                      ? "暂无反馈，监控程序会自动同步 GitHub 评论。"
                      : "暂无反馈，此 PR 的后台监控已暂停。"}
                  </div>
                ) : (
                  selectedPR.feedbackItems.map((item) => (
                    <FeedbackRow
                      key={item.id}
                      item={item}
                      prId={selectedPR.id}
                      readOnly={isArchived}
                      globalDrainMode={globalDrainMode}
                    />
                  ))
                )}
              </div>
            </>
          ) : selectedPRSummary ? (
            // The detail payload is fetched separately; on mobile this pane is the
            // whole screen, so an unqualified empty state would read as a dead end.
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-body text-muted-foreground" data-testid="pr-detail-loading">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                正在加载 PR…
              </span>
              <button
                type="button"
                onClick={() => setMobilePane("list")}
                className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border px-2.5 text-label uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background lg:hidden"
              >
                所有 PR
              </button>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-body text-muted-foreground">
              <span className="text-center">
                <span className="hidden lg:inline">请从左侧面板选择 PR。</span>
                <span className="lg:hidden">尚未选择 PR。</span>
              </span>
              <button
                type="button"
                onClick={() => setMobilePane("list")}
                data-testid="pr-detail-empty-back"
                className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border px-2.5 text-label uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background lg:hidden"
              >
                所有 PR
              </button>
            </div>
          )}
        </div>

        <RightPanel
          mobileHidden={mobilePane === "list"}
          prId={selectedPRId}
          activities={activities}
          queueStatusById={queueStatusById}
          isCollapsed={isActivityPanelCollapsed}
          onToggleCollapsed={() => setIsActivityPanelCollapsed((current) => !current)}
          idleReason={activityIdleReason}
        />
      </div>
      <div className="fixed bottom-4 right-4 z-50">
        {isAskOpen && (
          <div className="mb-2 h-[32rem] w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-background shadow-2xl">
            {selectedPRId ? (
              <QAPanel prId={selectedPRId} globalDrainMode={globalDrainMode} />
            ) : (
              <div className="flex h-full items-center justify-center p-4 text-body text-muted-foreground">
                选择 PR 后即可提问。
              </div>
            )}
          </div>
        )}
        <span data-testid="tab-ask" className="sr-only">询问代理</span>
        <button
          type="button"
          onClick={() => setIsAskOpen((current) => !current)}
          data-testid="button-ask-agent-fab"
          title={isAskOpen ? "关闭代理问答" : "打开代理问答"}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-primary bg-primary text-primary-foreground shadow-lg transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <Bot className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
