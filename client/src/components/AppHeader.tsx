import type { ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ActivitySnapshot, AgentSpendSummary, Config, RuntimeState } from "@shared/schema";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToastAction } from "@/components/ui/toast";
import { ThemeToggle } from "@/components/ThemeToggle";
import { toast } from "@/hooks/use-toast";
import { ACTIVITY_POLL_INTERVAL_MS, getUiPollIntervalMs } from "@/lib/polling";

type AppHeaderSection = "dashboard" | "prs" | "issues" | "releases" | "deployments" | "logs" | "settings";
type GitHubRateLimitState = {
  limited: boolean;
  resetAt: string | null;
  recentlyLimited: boolean;
  lastLimitedAt: string | null;
  resources?: {
    core?: GitHubRateLimitResourceState;
    graphql?: GitHubRateLimitResourceState;
    search?: GitHubRateLimitResourceState;
  };
};

type GitHubRateLimitResourceState = {
  limited: boolean;
  resetAt: string | null;
  recentlyLimited: boolean;
  lastLimitedAt: string | null;
  budget: { remaining: number; limit: number; percentRemaining: number; resetAt: string | null } | null;
  belowReserve: boolean;
  belowFloor: boolean;
};

const PRIMARY_NAV_ITEMS: Array<{ section: AppHeaderSection; label: string; href: string }> = [
  { section: "dashboard", label: "总览", href: "/" },
  { section: "issues", label: "议题", href: "/issues" },
  { section: "prs", label: "PR", href: "/prs" },
  { section: "releases", label: "发布", href: "/releases" },
  { section: "deployments", label: "部署", href: "/deployments" },
];

const SECONDARY_NAV_ITEMS: Array<{ section: AppHeaderSection; label: string; href: string }> = [
  { section: "logs", label: "日志", href: "/logs" },
  { section: "settings", label: "设置", href: "/settings" },
];

function navLinkClass(selected: boolean) {
  return `inline-flex min-h-8 items-center rounded-md border px-2 py-1 text-label uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:min-h-0 ${
    selected
      ? "border-primary/40 bg-primary/10 text-primary"
      : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
  }`;
}

function PatchdeckMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-label="PatchDeck">
      {/* patch cable (drawn first so jacks render on top) */}
      <path
        d="M4 4 Q 9 8 14 9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* row 1 */}
      <circle cx="4" cy="4" r="1.5" fill="currentColor" />
      <circle cx="9" cy="4" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="14" cy="4" r="1" stroke="currentColor" strokeWidth="1" />
      {/* row 2 */}
      <circle cx="4" cy="9" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="9" cy="9" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="14" cy="9" r="1.5" fill="currentColor" />
      {/* row 3 */}
      <circle cx="4" cy="14" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="9" cy="14" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="14" cy="14" r="1" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

type AutoModeChipState = "paused" | "auto" | "partial" | "manual";

function describeAutoModeState(state: AutoModeChipState): { label: string; chipClass: string; dotClass: string } {
  switch (state) {
    case "paused":
      return {
        label: "已暂停",
        chipClass: "border-warning-border bg-warning-muted text-warning-foreground hover:border-warning",
        dotClass: "bg-warning",
      };
    case "auto":
      return {
        label: "自动",
        chipClass: "border-success-border bg-success-muted text-success-foreground hover:border-success",
        dotClass: "bg-success animate-pulse",
      };
    case "partial":
      return {
        label: "部分自动",
        chipClass: "border-warning-border bg-warning-muted/60 text-warning-foreground hover:border-warning",
        dotClass: "bg-warning",
      };
    case "manual":
      return {
        label: "手动",
        chipClass: "border-border bg-muted text-muted-foreground hover:border-foreground/30",
        dotClass: "bg-muted-foreground",
      };
  }
}

function AutoModeButton() {
  const queryClient = useQueryClient();
  const { data: runtimeState } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 3000,
  });
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });

  const drainMode = runtimeState?.drainMode === true;
  const autoPrs = config?.autoPrs !== false;
  const autoIssues = config?.autoIssues !== false;

  const chipState: AutoModeChipState =
    drainMode ? "paused"
      : autoPrs && autoIssues ? "auto"
        : !autoPrs && !autoIssues ? "manual"
          : "partial";
  const { label, chipClass, dotClass } = describeAutoModeState(chipState);

  const updateConfigMutation = useMutation({
    mutationFn: async (updates: Partial<Config>) => {
      const res = await apiRequest("PATCH", "/api/config", updates);
      return res.json();
    },
    onMutate: async (updates) => {
      await queryClient.cancelQueries({ queryKey: ["/api/config"] });
      const previous = queryClient.getQueryData<Config>(["/api/config"]);
      if (previous) {
        queryClient.setQueryData<Config>(["/api/config"], { ...previous, ...updates });
      }
      return { previous };
    },
    onError: (_error, _updates, context) => {
      if (context?.previous) {
        queryClient.setQueryData<Config>(["/api/config"], context.previous);
      }
    },
    onSuccess: (updatedConfig) => {
      queryClient.setQueryData<Config>(["/api/config"], updatedConfig);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
    },
  });
  const drainMutation = useMutation({
    mutationFn: async (input: { enabled: boolean; reason?: string }) => {
      const res = await apiRequest("POST", "/api/runtime/drain", input);
      return res.json();
    },
    onSuccess: (_data, variables) => {
      if (variables.enabled) {
        toast({
          description: "后台同步已暂停，不再启动新的自动任务。",
          action: (
            <ToastAction
              altText="恢复后台同步"
              onClick={() => drainMutation.mutate({ enabled: false })}
            >
              撤销
            </ToastAction>
          ),
        });
      } else {
        toast({ description: "后台同步已恢复。" });
      }
    },
    onError: (error, variables) => {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        variant: "destructive",
        description: `${variables.enabled ? "暂停" : "恢复"}后台同步失败：${message}`,
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/runtime"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
    },
  });

  const switchPending = updateConfigMutation.isPending;
  const drainPending = drainMutation.isPending;

  const tooltip = drainMode
    ? "排空模式已暂停自动化，点击查看状态。"
    : chipState === "auto" ? "PR 和议题的自动模式已开启。"
      : chipState === "manual" ? "自动模式已关闭，PR 和议题仅在手动触发时处理。"
        : `部分自动模式：仅处理${autoPrs ? " PR" : "议题"}。`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={tooltip}
          aria-label={tooltip}
          data-testid="auto-mode-indicator"
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-label font-medium uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${chipClass}`}
        >
          <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-label font-medium uppercase tracking-wider text-muted-foreground">
            自动模式
          </span>
          <span className={`inline-flex items-center gap-1.5 text-label font-medium uppercase tracking-wider ${drainMode ? "text-warning-foreground" : "text-muted-foreground"}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
            {label}
          </span>
        </div>

        {drainMode && (
          <div className="mb-3 rounded-md border border-warning-border bg-warning-muted px-2 py-1.5 text-label text-warning-foreground">
            设置中已开启排空模式，以下开关不会恢复自动化。
          </div>
        )}

        <div className="space-y-2">
          <div
            className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1 py-1.5"
          >
            <label htmlFor="auto-mode-prs" className="flex min-w-0 cursor-pointer flex-col">
              <span className="text-body font-medium text-foreground">拉取请求</span>
              <span className="text-label text-muted-foreground">
                监控程序会为关注的 PR 安排自动任务，可在设置中按仓库调整。
              </span>
            </label>
            <Switch
              id="auto-mode-prs"
              checked={autoPrs}
              disabled={switchPending || !config}
              onCheckedChange={(next) => updateConfigMutation.mutate({ autoPrs: next })}
              data-testid="auto-mode-prs-switch"
            />
          </div>

          <div
            className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1 py-1.5"
          >
            <label htmlFor="auto-mode-issues" className="flex min-w-0 cursor-pointer flex-col">
              <span className="text-body font-medium text-foreground">议题</span>
              <span className="text-label text-muted-foreground">
                代理会自动评估并处理符合条件的议题。
              </span>
            </label>
            <Switch
              id="auto-mode-issues"
              checked={autoIssues}
              disabled={switchPending || !config}
              onCheckedChange={(next) => updateConfigMutation.mutate({ autoIssues: next })}
              data-testid="auto-mode-issues-switch"
            />
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-2">
          <div className="min-w-0 flex-1 text-label uppercase tracking-wider text-muted-foreground">
            后台同步
          </div>
          <button
            type="button"
            onClick={() => drainMutation.mutate(
              drainMode
                ? { enabled: false }
                : { enabled: true, reason: "通过顶部自动模式菜单暂停" },
            )}
            disabled={drainPending}
            data-testid="auto-mode-drain-toggle"
            className="inline-flex min-h-[28px] items-center rounded-md border border-border px-2.5 py-1.5 text-label uppercase tracking-wider text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
          >
            {drainPending ? "…" : drainMode ? "全部恢复" : "全部暂停"}
          </button>
        </div>

        <Link
          href="/settings"
          className="mt-3 inline-flex text-label uppercase tracking-wider text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          前往设置管理 →
        </Link>
      </PopoverContent>
    </Popover>
  );
}

function GitHubRateLimitNotice() {
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });
  const uiPollIntervalMs = getUiPollIntervalMs(config);
  const { data: githubRateLimit } = useQuery<GitHubRateLimitState>({
    queryKey: ["/api/github-rate-limit"],
    refetchInterval: uiPollIntervalMs,
  });
  const explicitlyLimited = githubRateLimit?.limited === true;
  const recentlyLimited = githubRateLimit?.recentlyLimited === true;
  const coreBudget = githubRateLimit?.resources?.core?.budget ?? null;
  const coreBudgetTight = githubRateLimit?.resources?.core?.belowReserve === true;
  const coreBudgetFloor = githubRateLimit?.resources?.core?.belowFloor === true;
  const { data: activities } = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activities"],
    refetchInterval: ACTIVITY_POLL_INTERVAL_MS,
    enabled: !explicitlyLimited,
  });

  const activityRateLimitMessage = !explicitlyLimited && activities
    ? [...activities.failed, ...activities.warnings]
      .map((item) => ("lastError" in item ? item.lastError : item.message) ?? "")
      .find((message) => message.toLowerCase().includes("请求限流")) ?? null
    : null;

  if (!explicitlyLimited && !recentlyLimited && !coreBudgetTight && !activityRateLimitMessage) {
    return null;
  }

  const resetTime = githubRateLimit?.resetAt
    ? new Date(githubRateLimit.resetAt).toLocaleTimeString("zh-CN")
    : null;

  const label = explicitlyLimited
    ? resetTime
      ? `GitHub 请求已限流，将于 ${resetTime} 恢复`
      : "GitHub 请求已限流"
    : coreBudgetFloor
      ? "GitHub 请求额度过低"
    : coreBudgetTight
      ? "GitHub 请求额度不足"
    : recentlyLimited
      ? "近期触发过 GitHub 限流"
    : "近期活动触发了 GitHub 限流";

  const tooltip = explicitlyLimited
    ? resetTime
      ? `GitHub 请求已限流，将于 ${resetTime} 恢复。请到设置中配置 Token。`
      : "GitHub 请求已限流，请到设置中配置 Token。"
    : coreBudgetFloor
      ? coreBudget
        ? `GitHub 核心请求额度剩余 ${coreBudget.remaining}/${coreBudget.limit}（${coreBudget.percentRemaining}%），所有 GitHub 任务正在等待。`
        : "GitHub 核心请求额度低于最低保留值，相关任务正在等待。"
    : coreBudgetTight
      ? coreBudget
        ? `GitHub 核心请求额度剩余 ${coreBudget.remaining}/${coreBudget.limit}（${coreBudget.percentRemaining}%），PR 后台监控任务已延后。`
        : "GitHub 核心请求额度不足，PR 后台监控任务已延后。"
    : activityRateLimitMessage ?? "近期活动出现 GitHub 限流错误，请到设置中配置 Token。";

  return (
    <Link
      href="/settings"
      title={tooltip}
      className="inline-flex max-w-[320px] items-center truncate whitespace-nowrap rounded-md border border-warning-border bg-warning-muted px-2.5 py-1 text-label uppercase tracking-wider text-warning-foreground transition-colors hover:border-warning hover:bg-warning-muted/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    >
      {label}
    </Link>
  );
}

function AgentSpendNotice() {
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });
  const uiPollIntervalMs = getUiPollIntervalMs(config);
  const { data: spend } = useQuery<AgentSpendSummary>({
    queryKey: ["/api/agent-spend"],
    refetchInterval: uiPollIntervalMs,
  });

  // No ceiling configured means unlimited, and an unlimited budget has nothing
  // worth taking up header space.
  if (!spend || spend.max === 0) {
    return null;
  }

  const resetTime = new Date(spend.resetsAt).toLocaleTimeString("zh-CN", {
    hour: "numeric",
    minute: "2-digit",
  });
  const nearingCeiling = spend.used >= Math.ceil(spend.max * 0.8);

  const label = spend.exhausted
    ? `代理调用已暂停，将于 ${resetTime} 恢复`
    : `代理调用 ${spend.used}/${spend.max} 次`;

  const tooltip = spend.exhausted
    ? `已达到每小时 ${spend.max} 次代理调用上限，排队任务预计在 ${resetTime} 自动继续。`
    : `过去一小时已调用代理 ${spend.used}/${spend.max} 次，包含 PR、议题、修复、发布和问答。`;

  const toneClass = spend.exhausted || nearingCeiling
    ? "border-warning-border bg-warning-muted text-warning-foreground hover:border-warning hover:bg-warning-muted/80"
    : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground";

  return (
    <Link
      href="/settings"
      title={tooltip}
      data-testid="agent-spend-notice"
      className={`inline-flex max-w-[320px] items-center truncate whitespace-nowrap rounded-md border px-2.5 py-1 text-label uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${toneClass}`}
    >
      {label}
    </Link>
  );
}

export function AppHeader({
  active,
  status,
  actions,
}: {
  active: AppHeaderSection;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-background/95 px-3 py-2.5 lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:px-4">
      <div className="flex min-w-0 items-center gap-2.5 lg:flex-wrap lg:justify-self-start">
        <Link
          href="/"
          className="inline-flex shrink-0 items-center gap-2 rounded-md px-1 text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          aria-label="PatchDeck 总览"
        >
          <PatchdeckMark />
          <span className="text-title font-semibold tracking-tight">PatchDeck</span>
        </Link>
        <nav aria-label="主导航" className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 lg:mx-0 lg:flex-initial lg:flex-wrap lg:overflow-visible lg:px-0 [&>*]:shrink-0 lg:[&>*]:shrink">
          {PRIMARY_NAV_ITEMS.map((item) => {
            const selected = active === item.section;
            return (
              <Link
                key={item.section}
                href={item.href}
                aria-current={selected ? "page" : undefined}
                className={navLinkClass(selected)}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="flex min-w-0 items-center justify-center gap-2 max-lg:empty:hidden">
        <GitHubRateLimitNotice />
        <AgentSpendNotice />
      </div>
      <div className="-mx-1 flex min-w-0 items-center gap-2 overflow-x-auto px-1 pb-0.5 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 lg:pb-0 lg:justify-self-end lg:justify-end [&>*]:shrink-0 lg:[&>*]:shrink">
        {status ? (
          <div className="flex min-w-0 items-center gap-2 border-l border-border/70 pl-2 text-label text-muted-foreground lg:flex-wrap lg:border-l-0 lg:pl-0 [&>*]:shrink-0 lg:[&>*]:shrink">
            {status}
          </div>
        ) : null}
        {actions ? (
          <div className="flex min-w-0 items-center gap-2 lg:flex-wrap [&>*]:shrink-0 lg:[&>*]:shrink [&_button]:min-h-8 [&_select]:min-h-8 sm:[&_button]:min-h-0 sm:[&_select]:min-h-0">
            {actions}
          </div>
        ) : null}
        <nav aria-label="辅助导航" className="flex items-center gap-1 lg:flex-wrap [&>*]:shrink-0 lg:[&>*]:shrink">
          {SECONDARY_NAV_ITEMS.map((item) => {
            const selected = active === item.section;
            return (
              <Link
                key={item.section}
                href={item.href}
                aria-current={selected ? "page" : undefined}
                className={navLinkClass(selected)}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <AutoModeButton />
        <ThemeToggle />
      </div>
    </header>
  );
}
