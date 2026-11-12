import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getRepoHref } from "@/lib/repoHref";
import { buildReviewModelOptions, findReviewModelSelection } from "@/lib/agentModelOptions";
import type { AgentModelCatalog, AgentModelOption, Config, ReleaseRun, RuntimeState, WatchedRepo } from "@shared/schema";
import { AppHeader } from "@/components/AppHeader";
import { UpdateBanner } from "@/components/UpdateBanner";
import { toast } from "@/hooks/use-toast";
import {
  getDrainActionLabel,
  getDrainStatusView,
} from "@/lib/runtimeDisplay";
import { getUiPollIntervalMs } from "@/lib/polling";

const WATCH_SCOPE_OPTIONS = [
  { value: "mine", label: "仅我的 PR" },
  { value: "team", label: "我和队友的 PR" },
] as const;

const ISSUE_WORK_MODE_OPTIONS = [
  { value: "manual", label: "手动" },
  { value: "auto", label: "自动" },
] as const;

const AGENT_OPTIONS = [
  { value: "codex", label: "codex" },
  { value: "claude", label: "claude" },
] as const;

const REPO_AGENT_OPTIONS = [
  { value: "inherit", label: "使用全局设置" },
  { value: "codex", label: "codex" },
  { value: "claude", label: "claude" },
] as const;

const DEFAULT_SETTING_VALUES = {
  maxTurns: 15,
  pollIntervalSeconds: 600,
  batchWindowSeconds: 600,
  maxChangesPerRun: 20,
  maxConcurrentBabysitRuns: 3,
  maxAgentRetryAttempts: 3,
  maxAgentInvocationsPerHour: 0,
  maxHealingAttemptsPerSession: 3,
  maxHealingAttemptsPerFingerprint: 2,
  maxConcurrentHealingRuns: 1,
  healingCooldownSeconds: 900,
  deploymentCheckDelaySeconds: 120,
  deploymentCheckTimeoutSeconds: 900,
  deploymentCheckPollSeconds: 60,
};

const EMPTY_AGENT_MODEL_CATALOG: AgentModelCatalog = {
  codex: [{ value: "", label: "CLI 默认" }],
  claude: [{ value: "", label: "CLI 默认" }],
};

function includeSelectedModel(
  options: readonly AgentModelOption[],
  selected: string | null | undefined,
): AgentModelOption[] {
  if (!selected || options.some((option) => option.value === selected)) {
    return [...options];
  }
  return [...options, { value: selected, label: selected }];
}

const CODEX_REASONING_OPTIONS = [
  { value: "default", label: "CLI 默认" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
] as const;

const CLAUDE_EFFORT_OPTIONS = [
  ...CODEX_REASONING_OPTIONS,
  { value: "max", label: "最高" },
] as const;

const DRAIN_PAUSED_LABEL = "已暂停";
const DRAIN_PAUSED_TITLE = "已因排空模式暂停";

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

type GitHubAuthStatus = {
  connected: boolean;
  login: string | null;
  source: "saved_token" | "env_token" | "gh_auth" | "gh_auth_fallback" | "none";
  error?: string;
};

type GitHubTokenTestResult = {
  index: number;
  token: string;
  status: "ok" | "throttled" | "error";
  login: string | null;
  remaining: number | null;
  resetAt: string | null;
  message: string;
  repoProbe: string | null;
};

type GitHubTokenTestResponse = {
  testedAt: string;
  results: GitHubTokenTestResult[];
};

type GitHubTokenTestLogEntry =
  | { kind: "result"; data: GitHubTokenTestResult }
  | { kind: "info"; message: string }
  | { kind: "error"; message: string };

type GitHubTokenTestLog = {
  timestamp: string;
  tokensTested: number;
  entries: GitHubTokenTestLogEntry[];
};

const TOKEN_TEST_LOG_LIMIT = 12;

const TOKEN_TEST_STATUS_CLASS: Record<GitHubTokenTestResult["status"], string> = {
  ok: "border-success-border bg-success-muted text-success-foreground",
  throttled: "border-warning-border bg-warning-muted text-warning-foreground",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};

const GITHUB_AUTH_SOURCE_LABEL: Record<GitHubAuthStatus["source"], string> = {
  saved_token: "已保存的 Token",
  env_token: "GITHUB_TOKEN",
  gh_auth: "gh 登录",
  gh_auth_fallback: "gh 登录回退",
  none: "未配置",
};

type WatchScope = (typeof WATCH_SCOPE_OPTIONS)[number]["value"];
type IssueWorkMode = (typeof ISSUE_WORK_MODE_OPTIONS)[number]["value"];
type RepoAgentOption = (typeof REPO_AGENT_OPTIONS)[number]["value"];

function getWatchScope(ownPrsOnly?: boolean): WatchScope {
  return ownPrsOnly === false ? "team" : "mine";
}

function getIssueWorkMode(issueAutoWork?: boolean): IssueWorkMode {
  return issueAutoWork ? "auto" : "manual";
}

function getIssueEvaluateMode(issueAutoEvaluate?: boolean): IssueWorkMode {
  return issueAutoEvaluate ? "auto" : "manual";
}

function getPrMonitorMode(prAutoMonitor?: boolean): IssueWorkMode {
  return prAutoMonitor === false ? "manual" : "auto";
}

function getRepoAgentOption(agent?: WatchedRepo["codingAgentOverride"]): RepoAgentOption {
  return agent ?? "inherit";
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function msToSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

function secondsToMs(seconds: number): number {
  return Math.max(1, seconds) * 1000;
}

function repoTestId(repo: string): string {
  return repo.replace("/", "-");
}

function isRepoFullyAuto(repo: WatchedRepo): boolean {
  return repo.prAutoMonitor !== false && repo.issueAutoEvaluate && repo.issueAutoWork;
}

function isRepoPartiallyAuto(repo: WatchedRepo): boolean {
  return repo.prAutoMonitor !== false || repo.issueAutoEvaluate || repo.issueAutoWork;
}

function SegmentControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  name,
  testIdPrefix,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  name: string;
  testIdPrefix: string;
}) {
  return (
    <div role="radiogroup" className="mt-1 flex flex-wrap gap-1">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <label
            key={option.value}
            data-testid={`${testIdPrefix}-${option.value}`}
            className={`cursor-pointer rounded-md border px-2 py-1 text-label font-medium transition-colors focus-within:ring-1 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background ${
              active
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
            } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={active}
              onChange={() => onChange(option.value)}
              disabled={disabled}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

function WatchScopeControl(props: {
  value: WatchScope;
  onChange: (value: WatchScope) => void;
  disabled?: boolean;
  name: string;
  testIdPrefix: string;
}) {
  return <SegmentControl options={WATCH_SCOPE_OPTIONS} {...props} />;
}

function IssueWorkModeControl(props: {
  value: IssueWorkMode;
  onChange: (value: IssueWorkMode) => void;
  disabled?: boolean;
  name: string;
  testIdPrefix: string;
}) {
  return <SegmentControl options={ISSUE_WORK_MODE_OPTIONS} {...props} />;
}

type SettingsTocItem = { id: string; label: string };
type SettingsTocGroup = { id: string; label: string; items: SettingsTocItem[] };

const SETTINGS_TOC: SettingsTocGroup[] = [
  {
    id: "sources",
    label: "关注来源",
    items: [
      { id: "sources-add", label: "添加" },
      { id: "sources-repos", label: "仓库" },
    ],
  },
  {
    id: "agent",
    label: "代理",
    items: [
      { id: "agent-models", label: "模型" },
      { id: "agent-autofix", label: "自动修复" },
      { id: "agent-tuning", label: "运行参数" },
      { id: "agent-ci", label: "CI 自动修复" },
    ],
  },
  {
    id: "delivery",
    label: "交付",
    items: [
      { id: "delivery-releases", label: "发布" },
      { id: "delivery-github", label: "GitHub" },
    ],
  },
  {
    id: "system",
    label: "系统",
    items: [
      { id: "system-runtime", label: "运行状态" },
      { id: "system-remote", label: "远程访问" },
    ],
  },
];

function scrollToSettingsSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ block: "start" });
}

function SettingsTOC() {
  return (
    <aside className="hidden w-48 shrink-0 lg:block">
      <nav className="sticky top-6 text-body" aria-label="设置分类">
        <div className="mb-3 text-label font-medium uppercase tracking-wider text-muted-foreground">
          本页目录
        </div>
        <ul className="space-y-0.5">
          {SETTINGS_TOC.flatMap((group, gi) => [
            <li key={group.id} className={gi > 0 ? "mt-2" : ""}>
              <button
                type="button"
                onClick={() => scrollToSettingsSection(group.id)}
                className="block w-full rounded px-2 py-1 text-left text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {group.label}
              </button>
            </li>,
            ...group.items.map((item) => (
              <li key={item.id} className="pl-3">
                <button
                  type="button"
                  onClick={() => scrollToSettingsSection(item.id)}
                  className="block w-full rounded px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {item.label}
                </button>
              </li>
            )),
          ])}
        </ul>
      </nav>
    </aside>
  );
}

function SettingsGroup({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <header className="mb-5 border-b border-border pb-3">
        <h2 className="text-title font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-body text-muted-foreground">{description}</p>
        ) : null}
      </header>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

function SettingsSubsection({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className="scroll-mt-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-body font-medium text-foreground">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-label text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function Settings() {
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });
  const { data: agentModelCatalog } = useQuery<AgentModelCatalog>({
    queryKey: ["/api/agent-models"],
    staleTime: 60_000,
  });
  const modelCatalog = agentModelCatalog ?? EMPTY_AGENT_MODEL_CATALOG;
  const codexModelOptions = includeSelectedModel(modelCatalog.codex, config?.codexModel);
  const claudeModelOptions = includeSelectedModel(modelCatalog.claude, config?.claudeModel);
  const primaryModel = config?.codingAgent === "codex"
    ? config.codexModel
    : config?.claudeModel ?? "";
  const reviewModelOptions = buildReviewModelOptions(modelCatalog, {
    agent: config?.codingAgent ?? "claude",
    model: primaryModel,
  });
  const selectedReviewOption = reviewModelOptions.find((option) =>
    option.agent === config?.reviewAgent && option.model === config.reviewModel
  );

  const [newGithubToken, setNewGithubToken] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [githubCommentAppNameDraft, setGithubCommentAppNameDraft] = useState("patchdeck");
  const [webUsernameDraft, setWebUsernameDraft] = useState("");
  const [webPasswordDraft, setWebPasswordDraft] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addRepo, setAddRepo] = useState("");
  const [watchScope, setWatchScope] = useState<WatchScope>("mine");
  const [tokenTestLogs, setTokenTestLogs] = useState<GitHubTokenTestLog[]>([]);
  const githubTokens = config?.githubTokens ?? (config?.githubToken ? [config.githubToken] : []);
  const githubCommentAppName = config?.githubCommentAppName ?? "patchdeck";

  useEffect(() => {
    setGithubCommentAppNameDraft(githubCommentAppName);
  }, [githubCommentAppName]);

  useEffect(() => {
    setWebUsernameDraft(config?.webUsername ?? "");
    setWebPasswordDraft(config?.webPassword ?? "");
  }, [config?.webUsername, config?.webPassword]);

  const updateGithubTokens = (tokens: string[]) => {
    updateConfigMutation.mutate({ githubTokens: tokens });
  };
  const moveGithubToken = (fromIndex: number, toIndex: number) => {
    const next = [...githubTokens];
    const [token] = next.splice(fromIndex, 1);
    if (!token) {
      return;
    }
    next.splice(toIndex, 0, token);
    updateGithubTokens(next);
  };
  const removeGithubToken = (index: number) => {
    updateGithubTokens(githubTokens.filter((_, i) => i !== index));
  };

  const { data: runtimeState, isError: runtimeStateIsError } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 5000,
  });
  const uiPollIntervalMs = getUiPollIntervalMs(config);
  const { data: githubRateLimit } = useQuery<GitHubRateLimitState>({
    queryKey: ["/api/github-rate-limit"],
    refetchInterval: uiPollIntervalMs,
  });
  const githubBudgetRows = (["core", "graphql", "search"] as const).map((resource) => ({
    resource,
    state: githubRateLimit?.resources?.[resource],
  }));
  const { data: githubAuthStatus } = useQuery<GitHubAuthStatus>({
    queryKey: ["/api/github-auth/status"],
    refetchInterval: uiPollIntervalMs,
  });
  const drainStatusView = getDrainStatusView(runtimeState, runtimeStateIsError);
  const globalDrainMode = runtimeState?.drainMode === true;

  const { data: repos = [] } = useQuery<WatchedRepo[]>({
    queryKey: ["/api/repos/settings"],
    refetchInterval: 5000,
  });

  const drainMutation = useMutation({
    mutationFn: async (input: { enabled: boolean; reason?: string }) => {
      const res = await apiRequest("POST", "/api/runtime/drain", input);
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/runtime"] });
      toast({
        description: variables.enabled
          ? "自动化已暂停，不再启动新任务，正在运行的任务会继续完成。"
          : "自动化已恢复。",
      });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `更新排空模式失败：${error.message}` });
    },
  });

  const updateConfigMutation = useMutation({
    mutationFn: async (updates: Partial<Config>) => {
      const res = await apiRequest("PATCH", "/api/config", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agent-models"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/github-auth/status"] });
      toast({ description: "设置已保存。" });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `保存失败：${error.message}` });
    },
  });

  const syncReposMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/repos/sync");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({ description: "仓库同步已加入队列。" });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `无法获取仓库：${error.message}` });
    },
  });

  const updateRepoSettingsMutation = useMutation({
    mutationFn: async (updates: { repo: string } & Partial<Omit<WatchedRepo, "repo">>) => {
      const res = await apiRequest("PATCH", "/api/repos/settings", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({ description: "仓库设置已保存。" });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `无法更新仓库设置：${error.message}` });
    },
  });

  const testGitHubTokensMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/github-tokens/test");
      return res.json() as Promise<GitHubTokenTestResponse>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/github-auth/status"] });
      const entries: GitHubTokenTestLogEntry[] = result.results.length === 0
        ? [{ kind: "info", message: "没有可测试的 GitHub Token。" }]
        : result.results.map((data) => ({ kind: "result", data }));

      setTokenTestLogs((previous) => [
        { timestamp: result.testedAt, tokensTested: result.results.length, entries },
        ...previous,
      ].slice(0, TOKEN_TEST_LOG_LIMIT));

      toast({ description: "GitHub Token 测试完成。" });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const errorEntries: GitHubTokenTestLogEntry[] = [{ kind: "error", message }];
      setTokenTestLogs((previous) => [
        {
          timestamp: new Date().toISOString(),
          tokensTested: 0,
          entries: errorEntries,
        },
        ...previous,
      ].slice(0, TOKEN_TEST_LOG_LIMIT));
      toast({ variant: "destructive", description: `GitHub Token 测试失败：${message}` });
    },
  });

  const removeRepoMutation = useMutation({
    mutationFn: async ({ repo, mode }: { repo: string; mode: "soft" | "hard" }) => {
      const res = await apiRequest("DELETE", `/api/repos/settings/${encodeURIComponent(repo)}?mode=${mode}`);
      return res.json() as Promise<{ repo: string; mode: "soft" | "hard"; removedPrs: number }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs/archived"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({
        description: result.mode === "hard"
          ? `已移除 ${result.repo} 及其 ${result.removedPrs} 个跟踪的 PR。`
          : `已停止关注 ${result.repo}。`,
      });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `无法移除仓库：${error.message}` });
    },
  });

  const manualReleaseMutation = useMutation({
    mutationFn: async (repo: string) => {
      const res = await apiRequest("POST", "/api/repos/release", { repo });
      return res.json() as Promise<ReleaseRun>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/releases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      toast({ description: "发布任务已加入队列。" });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `无法安排发布：${error.message}` });
    },
  });

  const addMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/prs", { url });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      setAddUrl("");
      toast({ description: "已添加 PR。" });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `无法添加 PR：${error.message}` });
    },
  });

  const addRepoMutation = useMutation({
    mutationFn: async ({ repo }: { repo: string; watchScope: WatchScope }) => {
      const res = await apiRequest("POST", "/api/repos", { repo });
      return res.json() as Promise<{ repo: string }>;
    },
    onSuccess: async (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      setAddRepo("");
      setWatchScope("mine");

      if (variables.watchScope === "team") {
        try {
          const res = await apiRequest("PATCH", "/api/repos/settings", {
            repo: data.repo,
            ownPrsOnly: false,
          });
          await res.json();
          queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
        } catch (error) {
          toast({
            variant: "destructive",
            description: `仓库已添加，但无法更新跟踪范围：${error instanceof Error ? error.message : String(error)}`,
          });
          return;
        }
      }

      toast({ description: "已添加仓库。" });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `无法关注仓库：${error.message}` });
    },
  });

  return (
    <div className="flex min-h-screen flex-col">
      <UpdateBanner />
      <AppHeader active="settings" />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
            <div>
              <h1 className="text-display font-semibold tracking-tight text-foreground">设置</h1>
              <p className="mt-1 text-body text-muted-foreground">
                配置关注范围、代理行为和发布方式。
              </p>
            </div>
          </div>
          <div className="flex gap-8">
            <SettingsTOC />
            <div className="min-w-0 flex-1 space-y-12">
              <SettingsGroup id="sources" title="关注来源" description="配置 PatchDeck 的关注范围。">
                <SettingsSubsection id="sources-add" title="添加" description="添加 PR 或关注其他仓库。">
            <div className="grid gap-3 md:grid-cols-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (addUrl.trim()) addMutation.mutate(addUrl.trim());
                }}
                className="rounded-md border border-border p-4"
              >
                <label htmlFor="settings-add-pr" className="text-body">拉取请求</label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="settings-add-pr"
                    type="text"
                    value={addUrl}
                    onChange={(e) => setAddUrl(e.target.value)}
                    placeholder="github.com/owner/repo/pull/123"
                    aria-label="GitHub PR 链接"
                    data-testid="input-add-pr"
                    className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-body placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  />
                  <button
                    type="submit"
                    disabled={addMutation.isPending || !addUrl.trim()}
                    data-testid="button-add-pr"
                    className="cursor-pointer rounded-md border border-primary bg-primary px-3 py-1 text-label font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    添加
                  </button>
                </div>
              </form>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const repo = addRepo.trim();
                  if (repo) {
                    addRepoMutation.mutate({ repo, watchScope });
                  }
                }}
                className="rounded-md border border-border p-4"
              >
                <label htmlFor="settings-add-repo" className="text-body">仓库</label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="settings-add-repo"
                    type="text"
                    value={addRepo}
                    onChange={(e) => setAddRepo(e.target.value)}
                    placeholder="owner/repo"
                    aria-label="仓库所有者和名称"
                    data-testid="input-add-repo"
                    className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-body placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  />
                  <button
                    type="submit"
                    disabled={addRepoMutation.isPending || !addRepo.trim()}
                    data-testid="button-add-repo"
                    className="cursor-pointer rounded-md border border-primary bg-primary px-3 py-1 text-label font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    关注
                  </button>
                </div>
                <div className="mt-3">
                  <div className="text-label uppercase tracking-wider text-muted-foreground">
                    自动跟踪
                  </div>
                  <WatchScopeControl
                    value={watchScope}
                    onChange={setWatchScope}
                    disabled={addRepoMutation.isPending}
                    name="watch-scope"
                    testIdPrefix="watch-scope"
                  />
                </div>
              </form>
            </div>
                </SettingsSubsection>

                <SettingsSubsection
                  id="sources-repos"
                  title="仓库"
                  description="按仓库配置自动化、议题处理和发布。"
                  action={
                    <button
                      type="button"
                      onClick={() => syncReposMutation.mutate()}
                      disabled={syncReposMutation.isPending || globalDrainMode}
                      title={globalDrainMode ? DRAIN_PAUSED_TITLE : "从 GitHub 同步关注的仓库"}
                      data-testid="button-sync-repos"
                      className="cursor-pointer rounded-md border border-primary bg-primary px-3 py-1 text-body font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {globalDrainMode ? DRAIN_PAUSED_LABEL : syncReposMutation.isPending ? "正在同步…" : "同步"}
                    </button>
                  }
                >
            {repos.length === 0 ? (
              <div className="rounded-md border border-border p-4 text-body text-muted-foreground">
                尚未关注任何仓库。
              </div>
            ) : (
              <div className="grid gap-3">
                {repos.map((repo) => {
                  const id = repoTestId(repo.repo);
                  const manualReleasePending = manualReleaseMutation.isPending
                    && manualReleaseMutation.variables === repo.repo;
                  const repoFullyAuto = isRepoFullyAuto(repo);
                  const repoPartiallyAuto = isRepoPartiallyAuto(repo);
                  const shouldShowRepoAutoAlert = config?.autoPrs !== false
                    && config?.autoIssues !== false
                    && !repoFullyAuto;

                  return (
                    <div
                      key={repo.repo}
                      data-testid={`tracked-repo-${repo.repo.replace("/", "-")}`}
                      className="rounded-md border border-border p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <a
                            href={getRepoHref(repo.repo)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all text-body text-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                          >
                            {repo.repo}
                          </a>
                          <div className="mt-1 text-label text-muted-foreground">
                            {repo.ownPrsOnly === false ? "跟踪团队 PR" : "跟踪我的 PR"} · PR 监控 {repo.prAutoMonitor === false ? "manual" : "auto"} · 议题评估 {repo.issueAutoEvaluate ? "auto" : "manual"} · 议题处理 {repo.issueAutoWork ? "auto" : "manual"}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-label uppercase tracking-wider">
                            <span
                              className={`inline-flex items-center border px-2 py-0.5 ${
                                repoFullyAuto
                                  ? "border-success-border bg-success-muted text-success-foreground"
                                  : repoPartiallyAuto
                                    ? "border-warning-border bg-warning-muted text-warning-foreground"
                                    : "border-border bg-muted text-muted-foreground"
                              }`}
                              data-testid={`tracked-repo-automation-mode-${repo.repo.replace("/", "-")}`}
                            >
                              {repoFullyAuto ? "自动模式" : repoPartiallyAuto ? "混合模式" : "手动模式"}
                            </span>
                            {repo.prAutoMonitor === false && (
                              <span className="inline-flex items-center border border-border px-2 py-0.5 text-muted-foreground">
                                PR：手动
                              </span>
                            )}
                            {!repo.issueAutoEvaluate && (
                              <span className="inline-flex items-center border border-border px-2 py-0.5 text-muted-foreground">
                                议题评估：手动
                              </span>
                            )}
                            {!repo.issueAutoWork && (
                              <span className="inline-flex items-center border border-border px-2 py-0.5 text-muted-foreground">
                                议题处理：手动
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => manualReleaseMutation.mutate(repo.repo)}
                          disabled={manualReleaseMutation.isPending || globalDrainMode}
                          title={globalDrainMode ? DRAIN_PAUSED_TITLE : "安排手动发布"}
                          data-testid={`tracked-repo-manual-release-${repo.repo.replace("/", "-")}`}
                          className="shrink-0 border border-border px-2 py-1 text-body uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                        >
                          {globalDrainMode ? DRAIN_PAUSED_LABEL : manualReleasePending ? "正在发布…" : "发布"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`停止关注 ${repo.repo}？已跟踪的 PR 历史会保留在 PatchDeck 中。`)) {
                              removeRepoMutation.mutate({ repo: repo.repo, mode: "soft" });
                            }
                          }}
                          disabled={removeRepoMutation.isPending}
                          title="停止关注此仓库，保留 PR 历史"
                          data-testid={`tracked-repo-soft-remove-${repo.repo.replace("/", "-")}`}
                          className="shrink-0 border border-border px-2 py-1 text-body uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                        >
                          停止关注
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`彻底移除 ${repo.repo}？这会停止关注，并从 PatchDeck 删除此仓库已跟踪的 PR。`)) {
                              removeRepoMutation.mutate({ repo: repo.repo, mode: "hard" });
                            }
                          }}
                          disabled={removeRepoMutation.isPending}
                          title="停止关注此仓库，并删除跟踪的 PR"
                          data-testid={`tracked-repo-hard-remove-${repo.repo.replace("/", "-")}`}
                          className="shrink-0 border border-destructive/60 px-2 py-1 text-body uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                        >
                          删除数据
                        </button>
                      </div>
                      {shouldShowRepoAutoAlert && (
                        <div
                          data-testid={`tracked-repo-auto-alert-${repo.repo.replace("/", "-")}`}
                          className="mt-3 flex flex-wrap items-center justify-between gap-2 border border-warning-border bg-warning-muted px-3 py-2 text-label text-warning-foreground"
                        >
                          <span>
                            全局自动模式已开启，但此仓库尚未完全启用自动化。
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                prAutoMonitor: true,
                                issueAutoEvaluate: true,
                                issueAutoWork: true,
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            data-testid={`tracked-repo-enable-auto-${repo.repo.replace("/", "-")}`}
                            className="shrink-0 border border-warning-border bg-background px-2 py-1 text-label uppercase tracking-wider text-warning-foreground transition-colors hover:bg-warning-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-40"
                          >
                            为仓库启用自动化
                          </button>
                        </div>
                      )}
                      {config?.autoIssues === false && (
                        <div
                          data-testid={`tracked-repo-global-issues-off-${repo.repo.replace("/", "-")}`}
                          className="mt-3 border border-warning-border bg-warning-muted px-3 py-2 text-label text-warning-foreground"
                        >
                          全局议题自动模式已关闭，以下仓库议题设置暂不生效。可从“自动模式”菜单重新开启。
                        </div>
                      )}
                      <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <div>
                          <div className="text-label uppercase tracking-wider text-muted-foreground">
                            自动跟踪
                          </div>
                          <WatchScopeControl
                            value={getWatchScope(repo.ownPrsOnly)}
                            onChange={(value) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                ownPrsOnly: value === "mine",
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            name={`tracked-repo-scope-${repo.repo}`}
                            testIdPrefix={`tracked-repo-scope-${repo.repo.replace("/", "-")}`}
                          />
                        </div>
                        <div>
                          <div className="text-label uppercase tracking-wider text-muted-foreground">
                            PR 监控
                          </div>
                          <IssueWorkModeControl
                            value={getPrMonitorMode(repo.prAutoMonitor)}
                            onChange={(value) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                prAutoMonitor: value === "auto",
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            name={`tracked-repo-pr-monitor-${repo.repo}`}
                            testIdPrefix={`tracked-repo-pr-monitor-${repo.repo.replace("/", "-")}`}
                          />
                          <div className="mt-1 text-label text-muted-foreground">
                            手动模式仍会同步 PR 状态，但不会自动处理 PR。
                          </div>
                        </div>
                        <div>
                          <div className="text-label uppercase tracking-wider text-muted-foreground">
                            自动评估议题
                          </div>
                          <IssueWorkModeControl
                            value={getIssueEvaluateMode(repo.issueAutoEvaluate)}
                            onChange={(value) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                issueAutoEvaluate: value === "auto",
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending || repo.issueAutoWork}
                            name={`tracked-repo-issue-evaluate-mode-${repo.repo}`}
                            testIdPrefix={`tracked-repo-issue-evaluate-mode-${repo.repo.replace("/", "-")}`}
                          />
                        </div>
                        <div>
                          <div className="text-label uppercase tracking-wider text-muted-foreground">
                            议题处理模式
                          </div>
                          <IssueWorkModeControl
                            value={getIssueWorkMode(repo.issueAutoWork)}
                            onChange={(value) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                issueAutoWork: value === "auto",
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            name={`tracked-repo-issue-work-mode-${repo.repo}`}
                            testIdPrefix={`tracked-repo-issue-work-mode-${repo.repo.replace("/", "-")}`}
                          />
                          <div className="mt-1 text-label text-muted-foreground">
                            自动处理会同时开启自动评估。
                          </div>
                        </div>
                        <label className="flex items-end gap-2 text-label uppercase tracking-wider text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={repo.autoCreateReleases}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                autoCreateReleases: e.target.checked,
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            data-testid={`tracked-repo-auto-release-${id}`}
                            className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                          />
                          自动发布
                        </label>
                      </div>
                      <div className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-5">
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-agent-${id}`} className="text-label uppercase tracking-wider text-muted-foreground">
                            代理
                          </label>
                          <select
                            id={`tracked-repo-agent-${id}`}
                            value={getRepoAgentOption(repo.codingAgentOverride)}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                codingAgentOverride: e.target.value === "inherit"
                                  ? null
                                  : e.target.value as WatchedRepo["codingAgentOverride"],
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            {REPO_AGENT_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-codex-model-${id}`} className="text-label uppercase tracking-wider text-muted-foreground">
                            Codex 模型
                          </label>
                          <select
                            id={`tracked-repo-codex-model-${id}`}
                            value={repo.codexModel ?? ""}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                codexModel: emptyToNull(e.target.value),
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            <option value="">使用全局设置</option>
                            {includeSelectedModel(codexModelOptions, repo.codexModel).filter((option) => option.value !== "").map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-codex-reasoning-${id}`} className="text-label uppercase tracking-wider text-muted-foreground">
                            Codex 思考强度
                          </label>
                          <select
                            id={`tracked-repo-codex-reasoning-${id}`}
                            value={repo.codexReasoningEffort ?? ""}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                codexReasoningEffort: e.target.value === ""
                                  ? null
                                  : e.target.value as WatchedRepo["codexReasoningEffort"],
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            <option value="">使用全局设置</option>
                            {CODEX_REASONING_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-claude-model-${id}`} className="text-label uppercase tracking-wider text-muted-foreground">
                            Claude 模型
                          </label>
                          <select
                            id={`tracked-repo-claude-model-${id}`}
                            value={repo.claudeModel ?? ""}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                claudeModel: emptyToNull(e.target.value),
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            <option value="">使用全局设置</option>
                            {includeSelectedModel(claudeModelOptions, repo.claudeModel).filter((option) => option.value !== "").map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-claude-effort-${id}`} className="text-label uppercase tracking-wider text-muted-foreground">
                            Claude 思考强度
                          </label>
                          <select
                            id={`tracked-repo-claude-effort-${id}`}
                            value={repo.claudeEffort ?? ""}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                claudeEffort: e.target.value === ""
                                  ? null
                                  : e.target.value as WatchedRepo["claudeEffort"],
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            <option value="">使用全局设置</option>
                            {CLAUDE_EFFORT_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="mt-4 grid gap-2 border-t border-border pt-4">
                        <label htmlFor={`tracked-repo-agent-instructions-${id}`} className="text-label uppercase tracking-wider text-muted-foreground">
                          代理指令
                        </label>
                        <textarea
                          id={`tracked-repo-agent-instructions-${id}`}
                          defaultValue={repo.agentInstructions}
                          onBlur={(e) => {
                            const next = e.currentTarget.value;
                            if (next !== repo.agentInstructions) {
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                agentInstructions: next,
                              });
                            }
                          }}
                          disabled={updateRepoSettingsMutation.isPending}
                          rows={4}
                          placeholder="此仓库在议题处理和 PR 自动值守时使用的专属指令。"
                          className="min-h-24 resize-y border border-border bg-transparent px-3 py-2 text-body leading-relaxed focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
                </SettingsSubsection>
              </SettingsGroup>

              <SettingsGroup id="agent" title="代理" description="配置代理如何处理关注的任务。">
                <SettingsSubsection id="agent-models" title="模型">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <label htmlFor="settings-coding-agent" className="text-body">编码代理</label>
                  <div className="text-label text-muted-foreground">
                    执行修复的命令行代理
                  </div>
                </div>
                <select
                  id="settings-coding-agent"
                  value={config?.codingAgent ?? "codex"}
                  onChange={(e) => {
                    const newAgent = e.target.value as Config["codingAgent"];
                    updateConfigMutation.mutate({ codingAgent: newAgent });
                  }}
                  disabled={updateConfigMutation.isPending}
                  className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                >
                  {AGENT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="grid gap-2">
                  <label htmlFor="settings-codex-model" className="text-body uppercase tracking-wider text-muted-foreground">
                    Codex 模型
                  </label>
                  <select
                    id="settings-codex-model"
                    value={config?.codexModel ?? ""}
                    onChange={(e) => updateConfigMutation.mutate({ codexModel: e.target.value })}
                    disabled={updateConfigMutation.isPending}
                    className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                  >
                    {codexModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="settings-codex-reasoning" className="text-body uppercase tracking-wider text-muted-foreground">
                    Codex 思考强度
                  </label>
                  <select
                    id="settings-codex-reasoning"
                    value={config?.codexReasoningEffort ?? "default"}
                    onChange={(e) => updateConfigMutation.mutate({ codexReasoningEffort: e.target.value as Config["codexReasoningEffort"] })}
                    disabled={updateConfigMutation.isPending}
                    className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                  >
                    {CODEX_REASONING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="settings-claude-model" className="text-body uppercase tracking-wider text-muted-foreground">
                    Claude 模型
                  </label>
                  <select
                    id="settings-claude-model"
                    value={config?.claudeModel ?? "opus"}
                    onChange={(e) => updateConfigMutation.mutate({ claudeModel: e.target.value })}
                    disabled={updateConfigMutation.isPending}
                    className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                  >
                    {claudeModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="settings-claude-effort" className="text-body uppercase tracking-wider text-muted-foreground">
                    Claude 思考强度
                  </label>
                  <select
                    id="settings-claude-effort"
                    value={config?.claudeEffort ?? "default"}
                    onChange={(e) => updateConfigMutation.mutate({ claudeEffort: e.target.value as Config["claudeEffort"] })}
                    disabled={updateConfigMutation.isPending}
                    className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                  >
                    {CLAUDE_EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-3 border-t border-border pt-4 md:grid-cols-[minmax(0,1fr)_minmax(14rem,auto)] md:items-center">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={config?.secondModelReviewEnabled ?? false}
                    onChange={(e) => updateConfigMutation.mutate({ secondModelReviewEnabled: e.target.checked })}
                    disabled={updateConfigMutation.isPending || !selectedReviewOption}
                    className="mt-1 h-4 w-4 accent-foreground"
                    data-testid="checkbox-second-model-review"
                  />
                  <span>
                    <span className="block text-body">第二模型复核</span>
                    <span className="block text-label text-muted-foreground">
                      在 PatchDeck 提交和推送前，复核并纠正主代理的修改。
                    </span>
                  </span>
                </label>
                <div className="grid gap-2">
                  <label htmlFor="settings-review-model" className="text-label uppercase tracking-wider text-muted-foreground">
                    复核模型
                  </label>
                  <select
                    id="settings-review-model"
                    value={selectedReviewOption?.value ?? ""}
                    onChange={(e) => {
                      const selection = findReviewModelSelection(reviewModelOptions, e.target.value);
                      if (selection) {
                        updateConfigMutation.mutate({
                          reviewAgent: selection.agent,
                          reviewModel: selection.model,
                        });
                      }
                    }}
                    disabled={updateConfigMutation.isPending}
                    className="border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                    data-testid="select-review-model"
                  >
                    <option value="" disabled>选择复核模型</option>
                    {reviewModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-body">回退到其他编码代理</div>
                  <div className="text-label text-muted-foreground">
                    当前代理无法启动或认证时，尝试使用另一个本地代理运行任务。
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.fallbackToNextCodingAgent ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      fallbackToNextCodingAgent: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="mt-1 h-4 w-4 accent-foreground"
                  data-testid="checkbox-fallback-to-next-coding-agent"
                />
              </label>
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="agent-autofix" title="自动修复">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-body">自动修复冲突</div>
                  <div className="text-label text-muted-foreground">
                    跟踪的 PR 存在合并冲突时，让代理尝试修复。
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoResolveMergeConflicts ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoResolveMergeConflicts: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  data-testid="checkbox-auto-resolve-conflicts"
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </label>
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-body">自动更新文档</div>
                  <div className="text-label text-muted-foreground">
                    自动评估跟踪的 PR 是否需要更新文档。
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoUpdateDocs ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoUpdateDocs: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  data-testid="checkbox-auto-update-docs"
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </label>
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="agent-tuning" title="运行参数">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <SettingRow
                label="最大交互轮数"
                description="每条反馈允许的最大代理交互轮数"
                value={config?.maxTurns ?? 15}
                onChange={(v) => updateConfigMutation.mutate({ maxTurns: v })}
                defaultValue={DEFAULT_SETTING_VALUES.maxTurns}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="检查间隔（秒）"
                description="检查新反馈的频率"
                value={msToSeconds(config?.pollIntervalMs ?? 600000)}
                onChange={(v) => updateConfigMutation.mutate({ pollIntervalMs: secondsToMs(v) })}
                defaultValue={DEFAULT_SETTING_VALUES.pollIntervalSeconds}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="反馈聚合窗口（秒）"
                description="处理前聚合反馈的等待时间"
                value={msToSeconds(config?.batchWindowMs ?? 600000)}
                onChange={(v) => updateConfigMutation.mutate({ batchWindowMs: secondsToMs(v) })}
                defaultValue={DEFAULT_SETTING_VALUES.batchWindowSeconds}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="每次运行的最大修改数"
                description="并发修改数量上限"
                value={config?.maxChangesPerRun ?? 20}
                onChange={(v) => updateConfigMutation.mutate({ maxChangesPerRun: v })}
                defaultValue={DEFAULT_SETTING_VALUES.maxChangesPerRun}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="PR 处理并发上限"
                description="可同时处理的 PR 数量，其余任务排队等待"
                value={config?.maxConcurrentBabysitRuns ?? 3}
                onChange={(v) => updateConfigMutation.mutate({ maxConcurrentBabysitRuns: v })}
                defaultValue={DEFAULT_SETTING_VALUES.maxConcurrentBabysitRuns}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="代理重试次数上限"
                description="失败任务最多重新调用代理的次数，超过后等待人工处理。网络和 GitHub 失败使用独立重试机制，因为它们仅消耗请求。"
                value={config?.maxAgentRetryAttempts ?? 3}
                onChange={(v) => updateConfigMutation.mutate({ maxAgentRetryAttempts: v })}
                defaultValue={DEFAULT_SETTING_VALUES.maxAgentRetryAttempts}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="每小时代理调用上限"
                description="限制 PR、议题、修复、发布和问答的代理调用总数。达到上限后任务等待，额度恢复后自动继续。0 表示不限。"
                value={config?.maxAgentInvocationsPerHour ?? 0}
                onChange={(v) => updateConfigMutation.mutate({ maxAgentInvocationsPerHour: v })}
                defaultValue={DEFAULT_SETTING_VALUES.maxAgentInvocationsPerHour}
                disabled={updateConfigMutation.isPending}
              />
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="agent-ci" title="CI 自动修复">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-body">CI 自动修复</div>
                  <div className="text-label text-muted-foreground">
                    识别可修复的 CI 失败，并在隔离 worktree 中进行有限次数的修复。
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label="CI 自动修复"
                  checked={config?.autoHealCI ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoHealCI: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </div>
              <SettingRow
                label="每个会话的修复次数上限"
                description="单个修复会话允许的最大尝试次数"
                value={config?.maxHealingAttemptsPerSession ?? 3}
                onChange={(v) => updateConfigMutation.mutate({ maxHealingAttemptsPerSession: v })}
                defaultValue={DEFAULT_SETTING_VALUES.maxHealingAttemptsPerSession}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="相同故障的修复次数上限"
                description="相同故障特征允许的最大重试次数"
                value={config?.maxHealingAttemptsPerFingerprint ?? 2}
                onChange={(v) => updateConfigMutation.mutate({ maxHealingAttemptsPerFingerprint: v })}
                defaultValue={DEFAULT_SETTING_VALUES.maxHealingAttemptsPerFingerprint}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="修复并发上限"
                description="可同时运行的修复任务数量"
                value={config?.maxConcurrentHealingRuns ?? 1}
                onChange={(v) => updateConfigMutation.mutate({ maxConcurrentHealingRuns: v })}
                defaultValue={DEFAULT_SETTING_VALUES.maxConcurrentHealingRuns}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="修复冷却时间（秒）"
                description="冷却中的会话再次尝试前需要等待的时间"
                value={msToSeconds(config?.healingCooldownMs ?? 900000)}
                onChange={(v) => updateConfigMutation.mutate({ healingCooldownMs: secondsToMs(v) })}
                defaultValue={DEFAULT_SETTING_VALUES.healingCooldownSeconds}
                disabled={updateConfigMutation.isPending}
              />
              <label className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-body">部署自动修复</div>
                  <div className="text-label text-muted-foreground">
                    监控支持的平台在合并后的部署，失败时创建后续修复 PR。
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label="部署自动修复"
                  checked={config?.autoHealDeployments ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoHealDeployments: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </label>
              <SettingRow
                label="部署检查延迟（秒）"
                description="新部署产生后，首次检查前的等待时间"
                value={msToSeconds(config?.deploymentCheckDelayMs ?? 120000)}
                onChange={(v) => updateConfigMutation.mutate({ deploymentCheckDelayMs: secondsToMs(v) })}
                defaultValue={DEFAULT_SETTING_VALUES.deploymentCheckDelaySeconds}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="部署检查超时（秒）"
                description="等待部署检查结果的最长时间"
                value={msToSeconds(config?.deploymentCheckTimeoutMs ?? 900000)}
                onChange={(v) => updateConfigMutation.mutate({ deploymentCheckTimeoutMs: secondsToMs(v) })}
                defaultValue={DEFAULT_SETTING_VALUES.deploymentCheckTimeoutSeconds}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="部署检查间隔（秒）"
                description="部署修复检查平台状态的频率"
                value={msToSeconds(config?.deploymentCheckPollIntervalMs ?? 60000)}
                onChange={(v) => updateConfigMutation.mutate({ deploymentCheckPollIntervalMs: secondsToMs(v) })}
                defaultValue={DEFAULT_SETTING_VALUES.deploymentCheckPollSeconds}
                disabled={updateConfigMutation.isPending}
              />
            </div>
                </SettingsSubsection>
              </SettingsGroup>

              <SettingsGroup id="delivery" title="交付" description="发布与 GitHub 集成。">
                <SettingsSubsection id="delivery-releases" title="发布">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <label className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-body">自动创建发布</div>
                  <div className="text-label text-muted-foreground">
                    评估已合并 PR，由代理判断是否值得发布，并自动创建 GitHub 发布。
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoCreateReleases ?? false}
                  onChange={(e) => updateConfigMutation.mutate({ autoCreateReleases: e.target.checked })}
                  disabled={updateConfigMutation.isPending}
                  className="mt-1 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  data-testid="checkbox-auto-create-releases"
                />
              </label>
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="delivery-github" title="GitHub">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <div
                className="flex flex-col gap-2 border border-border/80 bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                data-testid="github-auth-status"
              >
                <div className="min-w-0">
                  <div className="text-label uppercase tracking-wider text-muted-foreground">当前账号</div>
                  <div className="truncate font-mono text-body">
                    {githubAuthStatus?.connected && githubAuthStatus.login
                      ? `@${githubAuthStatus.login}`
                      : "未连接"}
                  </div>
                  {githubAuthStatus?.error ? (
                    <div className="mt-1 text-label text-destructive">{githubAuthStatus.error}</div>
                  ) : null}
                </div>
                <div className="shrink-0 text-label text-muted-foreground">
                  来源： <span className="font-mono text-foreground">{GITHUB_AUTH_SOURCE_LABEL[githubAuthStatus?.source ?? "none"]}</span>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-body">Token 列表</div>
                    <div className="text-label text-muted-foreground">
                      按顺序尝试，优先于 GITHUB_TOKEN 和 gh 登录。细粒度 PAT 需要为目标仓库授予：元数据读取、内容读写（如需推送）、议题读写、拉取请求读写和检查读取权限。同一 GitHub 账号的 Token 共享请求额度。
                    </div>
                  </div>
                  {!showTokenInput && (
                    <button
                      type="button"
                      onClick={() => setShowTokenInput(true)}
                      className="border border-border px-2 py-1 text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    >
                      添加
                    </button>
                  )}
                </div>
                {githubTokens.length ? (
                  <div className="flex flex-col gap-2">
                    {githubTokens.map((token, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between gap-3 border border-border px-2 py-1.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-body">{token}</div>
                          <div className="text-label text-muted-foreground">
                            优先级 {index + 1}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => moveGithubToken(index, index - 1)}
                            disabled={index === 0 || updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            上移
                          </button>
                          <button
                            type="button"
                            onClick={() => moveGithubToken(index, index + 1)}
                            disabled={index === githubTokens.length - 1 || updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            下移
                          </button>
                          <button
                            type="button"
                            onClick={() => removeGithubToken(index)}
                            disabled={updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            移除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-label text-muted-foreground">尚未配置</div>
                )}
                {showTokenInput ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={newGithubToken}
                      onChange={(e) => setNewGithubToken(e.target.value)}
                      placeholder="ghp_..."
                      aria-label="GitHub Token"
                      className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const token = newGithubToken.trim();
                        if (token) {
                          updateGithubTokens([...githubTokens, token]);
                          setNewGithubToken("");
                          setShowTokenInput(false);
                        }
                      }}
                      disabled={!newGithubToken.trim() || updateConfigMutation.isPending}
                      className="border border-border px-2 py-1 text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                    >
                      添加
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowTokenInput(false);
                        setNewGithubToken("");
                      }}
                      className="px-2 py-1 text-body text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    >
                      取消
                    </button>
                  </div>
                ) : null}

                <div className="mt-1 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-label text-muted-foreground">
                      逐个检查已配置 Token 的 GitHub 认证和请求额度。
                    </div>
                    <div className="flex items-center gap-2">
                      {tokenTestLogs.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setTokenTestLogs([])}
                          data-testid="button-clear-github-token-tests"
                          className="px-2 py-1 text-body text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                        >
                          清除
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => testGitHubTokensMutation.mutate()}
                        disabled={testGitHubTokensMutation.isPending}
                        data-testid="button-test-github-tokens"
                        className="border border-border px-2 py-1 text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                      >
                        {testGitHubTokensMutation.isPending
                          ? `正在测试 ${githubTokens.length} 个 Token…`
                          : "测试 Token"}
                      </button>
                    </div>
                  </div>
                  <div className="min-h-[8rem] max-h-52 overflow-y-auto border border-border/80 bg-background/40 p-2 text-label leading-relaxed">
                    {tokenTestLogs.length === 0 ? (
                      <div className="text-muted-foreground">尚未运行 Token 测试。</div>
                    ) : (
                      tokenTestLogs.map((log, logIndex) => (
                        <div
                          key={`${log.timestamp}-${logIndex}`}
                          className="mb-3 last:mb-0 border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
                        >
                          <div className="mb-1 text-label uppercase tracking-wider text-muted-foreground">
                            {new Date(log.timestamp).toLocaleTimeString("zh-CN")}
                            {log.tokensTested > 0
                              ? ` · ${log.tokensTested} 个 Token`
                              : ""}
                          </div>
                          <div className="flex flex-col gap-1.5">
                            {log.entries.map((item, itemIndex) => {
                              const key = `${log.timestamp}-${logIndex}-${itemIndex}`;
                              if (item.kind === "result") {
                                const { data } = item;
                                const remaining = data.remaining === null ? "?" : String(data.remaining);
                                const resetAt = data.resetAt
                                  ? new Date(data.resetAt).toLocaleTimeString("zh-CN")
                                  : "—";
                                return (
                                  <div key={key} className="flex flex-col gap-0.5">
                                    <div className="flex flex-wrap items-center gap-2 font-mono">
                                      <span className="text-muted-foreground">#{data.index}</span>
                                      <span
                                        className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-label font-semibold uppercase tracking-wider ${TOKEN_TEST_STATUS_CLASS[data.status]}`}
                                      >
                                        {data.status}
                                      </span>
                                      <span className="text-foreground">{data.token}</span>
                                      <span className="text-muted-foreground">
                                        {data.login ?? "未登录"} · 剩余 {remaining} · 重置时间 {resetAt}
                                        {data.repoProbe ? ` · 仓库探测 ${data.repoProbe}` : ""}
                                      </span>
                                    </div>
                                    <div className="break-words pl-1 text-muted-foreground">
                                      {data.message}
                                    </div>
                                  </div>
                                );
                              }
                              if (item.kind === "error") {
                                return (
                                  <div key={key} className="flex flex-wrap items-center gap-2 font-mono">
                                    <span className="inline-flex items-center rounded-sm border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-label font-semibold uppercase tracking-wider text-destructive">
                                      错误
                                    </span>
                                    <span className="break-words text-destructive">{item.message}</span>
                                  </div>
                                );
                              }
                              return (
                                <div key={key} className="text-muted-foreground">{item.message}</div>
                              );
                            })}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="settings-github-comment-app-name" className="text-body">
                  GitHub 回复签名
                </label>
                <div className="text-label text-muted-foreground">
                  替换公开 GitHub 回复中的应用名称，留空则不显示。
                </div>
                <input
                  id="settings-github-comment-app-name"
                  type="text"
                  value={githubCommentAppNameDraft}
                  placeholder="留空则移除"
                  onChange={(e) => setGithubCommentAppNameDraft(e.target.value)}
                  onBlur={(e) => {
                    const githubCommentAppName = e.target.value;
                    if (githubCommentAppName !== (config?.githubCommentAppName ?? "patchdeck")) {
                      updateConfigMutation.mutate({ githubCommentAppName });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    }
                  }}
                  disabled={updateConfigMutation.isPending}
                  className="w-full border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-body">PR 评论中的项目链接</div>
                  <div className="text-label text-muted-foreground">
                    在代理发布的 GitHub PR 评论及页脚中，将回复签名链接到项目仓库。
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label="PR 评论中的项目链接"
                  checked={config?.includeRepositoryLinksInGitHubComments ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      includeRepositoryLinksInGitHubComments: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-body">GitHub 进度回复</div>
                  <div className="text-label text-muted-foreground">
                    自动处理评审意见时，公开回复“已接受／处理中／验证中”等状态。
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label="GitHub 进度回复"
                  checked={config?.postGitHubProgressReplies ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      postGitHubProgressReplies: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </div>

              <StringListRow
                label="可信评审者"
                description="这些 GitHub 用户的评论会跳过代理评估，直接接受并修复。"
                placeholder="octocat"
                values={config?.trustedReviewers ?? []}
                onChange={(next) => updateConfigMutation.mutate({ trustedReviewers: next })}
                disabled={!config || updateConfigMutation.isPending}
              />

              <StringListRow
                label="优先议题作者"
                description="这些 GitHub 用户提交的议题会优先于普通队列进行评估和处理。"
                placeholder="octocat"
                values={config?.priorityIssueAuthors ?? []}
                onChange={(next) => updateConfigMutation.mutate({ priorityIssueAuthors: next })}
                disabled={!config || updateConfigMutation.isPending}
              />

              <StringListRow
                label="忽略的机器人"
                description="忽略这些机器人账号发布的评论和评审。"
                placeholder="dependabot[bot]"
                values={config?.ignoredBots ?? []}
                onChange={(next) => updateConfigMutation.mutate({ ignoredBots: next })}
                disabled={!config || updateConfigMutation.isPending}
              />
            </div>
                </SettingsSubsection>
              </SettingsGroup>

              <SettingsGroup id="system" title="系统" description="运行状态和进程控制。">
                <SettingsSubsection id="system-runtime" title="运行状态">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              {(githubRateLimit?.limited || githubRateLimit?.recentlyLimited) ? (
                <div
                  className="border-l-2 border-warning bg-warning-muted/40 px-3 py-2 text-label text-warning-foreground"
                  data-testid="runtime-github-rate-limit"
                >
                  {githubRateLimit?.limited && githubRateLimit.resetAt
                    ? `GitHub 请求已限流，将于 ${new Date(githubRateLimit.resetAt).toLocaleTimeString("zh-CN")} 恢复`
                    : "近期触发过 GitHub 限流，同步可能延迟。"}
                </div>
              ) : null}
              <div className="grid gap-3 text-label sm:grid-cols-3" data-testid="runtime-github-budget">
                {githubBudgetRows.map(({ resource, state }) => {
                  const budget = state?.budget ?? null;
                  const tone = state?.belowFloor
                    ? "border-destructive text-destructive"
                    : state?.belowReserve
                      ? "border-warning-border text-warning-foreground"
                      : "border-border text-muted-foreground";
                  return (
                    <div key={resource} className={`border-l-2 pl-2 ${tone}`}>
                      <div className="uppercase tracking-wider">{resource}</div>
                      <div className="mt-1 text-body text-foreground">
                        {budget ? `${budget.remaining}/${budget.limit}` : "未知"}
                      </div>
                      <div className="mt-0.5 uppercase tracking-wider">
                        {state?.belowFloor
                          ? "低于保留值"
                          : state?.belowReserve
                            ? "额度不足"
                            : budget
                              ? `剩余 ${budget.percentRemaining}%`
                              : "尚未获取"}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-body">自动化</div>
                  <div className="text-label text-muted-foreground">
                    排空模式会阻止新的代理任务，正在运行的任务会继续完成。
                  </div>
                  <div
                    className="mt-2 text-label"
                    aria-live="polite"
                    data-testid="text-drain-status"
                  >
                    <span className={drainStatusView.className}>{drainStatusView.label}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    drainMutation.mutate(
                      runtimeState?.drainMode
                        ? { enabled: false }
                        : { enabled: true, reason: "通过网页设置手动暂停" },
                    )
                  }
                  disabled={!runtimeState || drainMutation.isPending}
                  data-testid="button-toggle-drain"
                  className="shrink-0 border border-border px-2 py-1 text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                >
                  {getDrainActionLabel(runtimeState)}
                </button>
              </div>
              {runtimeState?.drainMode && (runtimeState.drainReason || runtimeState.drainRequestedAt) ? (
                <div className="border-l-2 border-destructive bg-muted/30 px-3 py-2 text-label">
                  {runtimeState.drainReason ? (
                    <div className="text-foreground">{runtimeState.drainReason}</div>
                  ) : null}
                  {runtimeState.drainRequestedAt ? (
                    <div className="mt-1 text-muted-foreground">
                      开始于 {new Date(runtimeState.drainRequestedAt).toLocaleString("zh-CN")}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="system-remote" title="远程访问">
            <div className="rounded-md border border-border p-4">
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
                <div>
                  <label htmlFor="settings-web-username" className="text-body">用户名</label>
                  <input
                    id="settings-web-username"
                    type="text"
                    value={webUsernameDraft}
                    onChange={(e) => setWebUsernameDraft(e.target.value)}
                    placeholder="operator"
                    aria-label="远程访问用户名"
                    data-testid="input-remote-access-username"
                    className="mt-2 w-full rounded-md border border-border bg-transparent px-2 py-1 text-body placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  />
                </div>
                <div>
                  <label htmlFor="settings-web-password" className="text-body">密码</label>
                  <input
                    id="settings-web-password"
                    type="password"
                    value={webPasswordDraft}
                    onChange={(e) => setWebPasswordDraft(e.target.value)}
                    placeholder="未配置"
                    aria-label="远程访问密码"
                    data-testid="input-remote-access-password"
                    className="mt-2 w-full rounded-md border border-border bg-transparent px-2 py-1 text-body placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  />
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateConfigMutation.mutate({
                      webUsername: webUsernameDraft,
                      webPassword: webPasswordDraft,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  data-testid="button-save-remote-access"
                  className="cursor-pointer rounded-md border border-primary bg-primary px-3 py-1 text-body font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                >
                  保存
                </button>
              </div>
              <p className="mt-3 text-label text-muted-foreground">
                远程访问需要使用这些凭据登录，本机回环访问无需登录。
              </p>
            </div>
                </SettingsSubsection>
              </SettingsGroup>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StringListRow({
  label,
  description,
  placeholder,
  values,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const inputId = `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const descriptionId = `${inputId}-description`;

  const addValue = () => {
    const trimmed = draft.trim();
    const lowered = trimmed.toLowerCase();
    if (!trimmed || values.some((v) => v.toLowerCase() === lowered)) {
      setDraft("");
      return;
    }
    onChange([...values, trimmed]);
    setDraft("");
  };

  const removeValue = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-body">{label}</span>
          <span id={descriptionId} className="block text-label text-muted-foreground">{description}</span>
          <input
            id={inputId}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addValue();
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            aria-describedby={descriptionId}
            className="mt-2 w-full min-w-0 border border-border bg-transparent px-2 py-1 text-body focus:border-primary focus:outline-none disabled:opacity-50"
          />
        </label>
        <button
          type="button"
          onClick={addValue}
          disabled={!draft.trim() || disabled}
          className="border border-border px-2 py-1 text-body transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          添加
        </button>
      </div>
      {values.length ? (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value, index) => (
            <span
              key={value}
              className="inline-flex items-center gap-1.5 border border-border px-2 py-0.5 font-mono text-body"
            >
              {value}
              <button
                type="button"
                onClick={() => removeValue(index)}
                disabled={disabled}
                aria-label={`移除 ${value}`}
                className="text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-label text-muted-foreground">尚未配置</div>
      )}
    </div>
  );
}

function SettingRow({
  label,
  description,
  value,
  onChange,
  defaultValue,
  disabled,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  defaultValue?: number;
  disabled: boolean;
}) {
  const inputId = `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const descriptionId = `${inputId}-description`;
  const canReset = defaultValue !== undefined && value !== defaultValue;

  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <label htmlFor={inputId} className="text-body">{label}</label>
        <div id={descriptionId} className="text-label text-muted-foreground">{description}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canReset && (
          <button
            type="button"
            onClick={() => onChange(defaultValue)}
            disabled={disabled}
            aria-label={`将${label}恢复为默认值`}
            className="rounded-md border border-border px-2 py-1 text-label uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
          >
            默认
          </button>
        )}
        <input
          id={inputId}
          type="number"
          value={value}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!isNaN(n)) onChange(n);
          }}
          disabled={disabled}
          aria-describedby={descriptionId}
          className="w-28 border border-border bg-transparent px-2 py-1 text-right text-body focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
        />
      </div>
    </div>
  );
}
