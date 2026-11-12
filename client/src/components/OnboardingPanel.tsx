import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Config, RuntimeState } from "@shared/schema";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { getUiPollIntervalMs } from "@/lib/polling";

const ONBOARDING_DISMISS_KEY = "onboarding-panel-dismissed-v2";
const ONBOARDING_LAST_GITHUB_USER_KEY = "onboarding-last-github-user-v1";
const ONBOARDING_LAST_HAS_TRACKED_REPO_KEY = "onboarding-last-has-tracked-repo-v1";
const ONBOARDING_LAST_HAS_REVIEWER_KEY = "onboarding-last-has-reviewer-v1";
const REVIEW_TOOL_LABELS = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
} as const;
const REVIEW_PROVIDER_GUIDES = [
  {
    label: "Gemini Code Assist",
    href: "https://github.com/apps/gemini-code-assist",
  },
  {
    label: "OpenAI Codex",
    href: "https://developers.openai.com/codex/integrations/github",
  },
  {
    label: "Claude Code",
    href: "https://support.claude.com/en/articles/14233555-set-up-code-review-for-claude-code",
  },
  {
    label: "Cursor",
    href: "https://cursor.com/docs/integrations/github",
  },
] as const;

type OnboardingStatus = {
  githubConnected: boolean;
  githubError?: string;
  githubUser?: string;
  repos: RepoOnboardingStatus[];
};
type GitHubRateLimitState = {
  limited: boolean;
  resetAt: string | null;
  recentlyLimited: boolean;
  lastLimitedAt: string | null;
};

type CodeReviewPresence = {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
};

type RepoOnboardingStatus = {
  repo: string;
  accessible: boolean;
  error?: string;
  codeReviews: CodeReviewPresence;
};

type InstallReviewTool = "claude" | "codex";
type ReviewTool = keyof CodeReviewPresence;
type OnboardingStepId = "github" | "repo" | "workflow";

type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  description: string;
  complete: boolean;
};

function isTransientGitHubWarning(githubError?: string): boolean {
  if (!githubError) return false;
  return /rate limit gate active/i.test(githubError);
}

function hasDetectedCodeReviewWorkflow(codeReviews: CodeReviewPresence) {
  return codeReviews.claude || codeReviews.codex || codeReviews.gemini;
}

function getDetectedReviewTools(codeReviews: CodeReviewPresence): ReviewTool[] {
  return (Object.entries(codeReviews) as Array<[ReviewTool, boolean]>)
    .filter(([, present]) => present)
    .map(([tool]) => tool);
}

export function getOnboardingPanelState(status: OnboardingStatus) {
  const transientGithubWarning = isTransientGitHubWarning(status.githubError);
  const githubStepComplete = status.githubConnected || transientGithubWarning;
  const accessibleRepos = status.repos.filter((repo) => repo.accessible);
  const inaccessibleRepos = transientGithubWarning ? [] : status.repos.filter((repo) => !repo.accessible);
  const reposWithReview = accessibleRepos.filter((repo) => hasDetectedCodeReviewWorkflow(repo.codeReviews));
  const reposMissingReview = accessibleRepos.filter((repo) => !hasDetectedCodeReviewWorkflow(repo.codeReviews));
  const repoStepComplete = transientGithubWarning ? true : accessibleRepos.length > 0;
  const workflowStepComplete = transientGithubWarning ? true : reposWithReview.length > 0;

  const steps: OnboardingStep[] = [
    {
      id: "github",
      title: "连接 GitHub",
      description: githubStepComplete
        ? `已连接${status.githubUser ? `，账号 @${status.githubUser}` : ""}。`
        : "连接 GitHub 后，即可读取仓库、同步反馈，并为仓库添加代码评审工作流。",
      complete: githubStepComplete,
    },
    {
      id: "repo",
      title: "关注第一个仓库或 PR",
      description: repoStepComplete
        ? transientGithubWarning
          ? "GitHub 请求暂时受限，现有仓库关注设置会保留。"
          : `正在关注 ${accessibleRepos.length} 个可访问仓库，可按仓库选择仅跟踪自己的 PR 或整个团队的 PR。`
        : "使用下方表单添加 PR 或关注仓库。添加 PR 时会同时关注所在仓库，并可选择仅跟踪自己的 PR 或整个团队的 PR。",
      complete: repoStepComplete,
    },
    {
      id: "workflow",
      title: "为仓库添加 CI 代码评审",
      description: workflowStepComplete
        ? transientGithubWarning
          ? "GitHub 请求暂时受限，现有评审设置会保留。"
          : `已在 ${reposWithReview.length} 个仓库中检测到评审工作流。`
        : accessibleRepos.length > 0
          ? "为已关注的仓库添加代码评审 GitHub Action，即可自动评审新 PR。PatchDeck 会跟踪反馈并安排修复。"
          : "先关注仓库，再为它添加代码评审 GitHub Action。",
      complete: workflowStepComplete,
    },
  ];

  const completedCount = steps.filter((step) => step.complete).length;
  const pendingSteps = steps.filter((step) => !step.complete);
  const dismissalKey = [
    ...pendingSteps.map((step) => step.id.toLowerCase()),
    ...inaccessibleRepos.map((repo) => "access:" + repo.repo.toLowerCase() + ":" + (repo.error?.slice(0, 100) ?? "").toLowerCase()),
  ].sort().join("|") || "complete";
  const hasIssues = pendingSteps.length > 0 || inaccessibleRepos.length > 0;
  const summary = pendingSteps.length > 0
    ? `已完成 ${completedCount}/${steps.length} 项`
    : `${inaccessibleRepos.length} 个访问问题`;

  return {
    accessibleRepos,
    hasIssues,
    inaccessibleRepos,
    reposMissingReview,
    reposWithReview,
    steps,
    pendingSteps,
    completedCount,
    dismissalKey,
    summary,
  };
}

function InlineCode({ children }: { children: string }) {
  return (
    <code className="rounded-md border border-border bg-muted/30 px-1 py-0.5 text-label font-mono">
      {children}
    </code>
  );
}

function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border border-border text-label text-muted-foreground">
        {number}
      </span>
      <div className="flex-1 text-body leading-relaxed">{children}</div>
    </div>
  );
}

function StepCard({
  step,
  index,
  children,
}: {
  step: OnboardingStep;
  index: number;
  children?: ReactNode;
}) {
  return (
    <div className={`border px-3 py-3 ${step.complete ? "border-border bg-background/60" : "border-warning-border bg-warning-muted"}`}>
      <div className="flex gap-3">
        <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border text-label ${step.complete ? "border-border text-foreground" : "border-warning-border text-warning-foreground"}`}>
          {step.complete ? "✓" : index}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label font-medium uppercase tracking-wider">{step.title}</span>
            <span className={`border px-1.5 py-0 text-label uppercase tracking-wider ${step.complete ? "border-border text-muted-foreground" : "border-warning-border text-warning-foreground"}`}>
              {step.complete ? "已完成" : "下一步"}
            </span>
          </div>
          <p className="text-body text-muted-foreground">{step.description}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function OnboardingPanel() {
  const [lastGitHubUser] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    return window.localStorage.getItem(ONBOARDING_LAST_GITHUB_USER_KEY);
  });
  const [lastHasTrackedRepo] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(ONBOARDING_LAST_HAS_TRACKED_REPO_KEY) === "1";
  });
  const [lastHasReviewer] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(ONBOARDING_LAST_HAS_REVIEWER_KEY) === "1";
  });
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    return window.localStorage.getItem(ONBOARDING_DISMISS_KEY);
  });
  const [expanded, setExpanded] = useState(true);

  const { data: runtimeState } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 5000,
  });
  const globalDrainMode = runtimeState?.drainMode === true;
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });
  const uiPollIntervalMs = getUiPollIntervalMs(config);
  const { data: status, isLoading } = useQuery<OnboardingStatus>({
    queryKey: ["/api/onboarding/status"],
    enabled: runtimeState !== undefined && !globalDrainMode,
    refetchInterval: globalDrainMode ? false : uiPollIntervalMs,
  });
  const { data: githubRateLimit } = useQuery<GitHubRateLimitState>({
    queryKey: ["/api/github-rate-limit"],
    refetchInterval: globalDrainMode ? false : uiPollIntervalMs,
  });

  const installWorkflowMutation = useMutation({
    mutationFn: async ({ repo, tool }: { repo: string; tool: InstallReviewTool }) => {
      const res = await apiRequest("POST", "/api/onboarding/install-review", { repo, tool });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({
        description: `已为 ${variables.repo} 添加 ${REVIEW_TOOL_LABELS[variables.tool]} 评审工作流。`,
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        description: `无法添加评审工作流：${error.message}`,
      });
    },
  });

  if (isLoading || !status) return null;

  const effectiveGithubError = status.githubError
    ?? ((githubRateLimit?.limited || githubRateLimit?.recentlyLimited) ? "限流保护已生效" : undefined);
  const transientGithubWarning = isTransientGitHubWarning(effectiveGithubError);
  const hasCurrentReviewer = status.repos.some((repo) => hasDetectedCodeReviewWorkflow(repo.codeReviews));
  const shouldUseCachedRepoStatus = transientGithubWarning && status.repos.length === 0 && lastHasTrackedRepo;
  const cachedRepoStatus: RepoOnboardingStatus[] = shouldUseCachedRepoStatus
    ? [{
      repo: "cached/tracked-repo",
      accessible: true,
      codeReviews: {
        claude: lastHasReviewer,
        codex: lastHasReviewer,
        gemini: false,
      },
    }]
    : [];

  const displayStatus = {
    ...status,
    githubError: effectiveGithubError,
    githubUser: status.githubUser ?? lastGitHubUser ?? undefined,
    repos: shouldUseCachedRepoStatus ? cachedRepoStatus : status.repos,
  };
  if (typeof window !== "undefined" && status.githubUser) {
    window.localStorage.setItem(ONBOARDING_LAST_GITHUB_USER_KEY, status.githubUser);
  }
  if (typeof window !== "undefined" && status.repos.length > 0) {
    window.localStorage.setItem(ONBOARDING_LAST_HAS_TRACKED_REPO_KEY, "1");
    window.localStorage.setItem(
      ONBOARDING_LAST_HAS_REVIEWER_KEY,
      hasCurrentReviewer ? "1" : "0",
    );
  }

  const {
    accessibleRepos,
    completedCount,
    dismissalKey,
    hasIssues,
    inaccessibleRepos,
    reposMissingReview,
    reposWithReview,
    steps,
    summary,
  } = getOnboardingPanelState(displayStatus);
  const preferredTool = config?.codingAgent ?? "claude";
  const installOrder: InstallReviewTool[] = preferredTool === "codex"
    ? ["codex", "claude"]
    : ["claude", "codex"];

  if (!hasIssues || dismissedKey === dismissalKey) return null;

  return (
    <div className="shrink-0 border-b border-border bg-muted/35">
      <div className="flex items-center justify-between px-4 py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-left"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
          <span className="text-label font-medium uppercase tracking-wider">
            开始使用
          </span>
          <span className="text-label text-muted-foreground">{summary}</span>
          <span className="text-label text-muted-foreground">{expanded ? "▲" : "▼"}</span>
        </button>
        <button
          onClick={() => {
            if (typeof window !== "undefined") {
              window.localStorage.setItem(ONBOARDING_DISMISS_KEY, dismissalKey);
            }
            setDismissedKey(dismissalKey);
          }}
          className="text-label uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          关闭
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-label uppercase tracking-wider text-muted-foreground">
              设置清单
            </div>
            <div className="text-label text-muted-foreground">
              {completedCount} / {steps.length} 已完成
            </div>
          </div>

          <div className="space-y-3">
            {steps.map((step, index) => (
              <StepCard key={step.id} step={step} index={index + 1}>
                {step.id === "github" && !step.complete && (
                  <div className="space-y-2 pt-1">
                    {displayStatus.githubError && !isTransientGitHubWarning(displayStatus.githubError) && (
                      <p className="text-body text-destructive">{displayStatus.githubError}</p>
                    )}
                    <div className="space-y-1.5 text-body text-muted-foreground">
                      <Step number={1}>
                        运行 <InlineCode>gh auth login</InlineCode> ，或在本机设置 <InlineCode>GITHUB_TOKEN</InlineCode>，或在此处添加 Token： <Link href="/settings" className="underline underline-offset-2">设置</Link>。
                      </Step>
                      <Step number={2}>
                        如需保存凭据，可使用内置 Token 列表。细粒度 PAT 需要为目标仓库授予以下权限：元数据读取、内容读写（如需推送）、议题读写、拉取请求读写和检查读取。
                      </Step>
                    </div>
                  </div>
                )}

                {step.id === "repo" && !step.complete && (
                  <div className="pt-1 text-body text-muted-foreground">
                    可从左侧栏开始。使用 <span className="text-foreground">添加</span> 填写 PR 链接，或使用 <span className="text-foreground">关注</span> 填写 <InlineCode>owner/repo</InlineCode> 仓库标识，然后选择仅跟踪自己的 PR 或整个团队的 PR。
                  </div>
                )}

                {step.id === "workflow" && !step.complete && accessibleRepos.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className="space-y-2 border border-border bg-muted/40 px-3 py-2">
                      <p className="text-body text-muted-foreground">
                        这些 GitHub Actions 会在每个 PR 上运行并发表评审意见。PatchDeck 会读取意见、判断是否需要修改代码并安排修复。请选择适合项目的评审工具。
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-label">
                        {REVIEW_PROVIDER_GUIDES.map((provider) => (
                          <a
                            key={provider.href}
                            href={provider.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
                          >
                            {provider.label}
                          </a>
                        ))}
                      </div>
                    </div>
                    {reposMissingReview.map((repoStatus) => (
                      <div key={repoStatus.repo} className="flex flex-col gap-2 border border-border bg-background/50 px-3 py-2 md:flex-row md:items-center md:justify-between">
                        <div className="min-w-0">
                          <a
                            href={`https://github.com/${repoStatus.repo}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-label font-medium underline underline-offset-2"
                          >
                            {repoStatus.repo}
                          </a>
                          <p className="text-label text-muted-foreground">
                            此仓库尚未安装代码评审工作流。
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {installOrder.map((tool) => {
                            const isPending = installWorkflowMutation.isPending
                              && installWorkflowMutation.variables?.repo === repoStatus.repo
                              && installWorkflowMutation.variables?.tool === tool;
                            return (
                            <button
                              key={`${repoStatus.repo}-${tool}`}
                              type="button"
                              onClick={() => installWorkflowMutation.mutate({ repo: repoStatus.repo, tool })}
                              disabled={installWorkflowMutation.isPending || globalDrainMode}
                              className="border border-border px-2 py-1 text-label uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background disabled:opacity-40"
                            >
                              {globalDrainMode ? "已暂停" : isPending ? "正在添加…" : `添加 ${REVIEW_TOOL_LABELS[tool]} 工作流`}
                            </button>
                          );
                        })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {step.id === "workflow" && step.complete && reposWithReview.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className="space-y-2 border border-border bg-muted/40 px-3 py-2">
                      <p className="text-body text-muted-foreground">
                        这些 GitHub Actions 会在每个 PR 上运行并发表评审意见。PatchDeck 会读取意见、判断是否需要修改代码并安排修复。请选择适合项目的评审工具。
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-label">
                        {REVIEW_PROVIDER_GUIDES.map((provider) => (
                          <a
                            key={provider.href}
                            href={provider.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
                          >
                            {provider.label}
                          </a>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {reposWithReview.map((repoStatus) => {
                        const detectedTools = getDetectedReviewTools(repoStatus.codeReviews)
                          .map((tool) => REVIEW_TOOL_LABELS[tool])
                          .join(" + ");
                        return (
                          <span
                            key={repoStatus.repo}
                            className="border border-border px-2 py-0.5 text-label uppercase tracking-wider text-muted-foreground"
                          >
                            {repoStatus.repo} · {detectedTools}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </StepCard>
            ))}
          </div>

          {inaccessibleRepos.length > 0 && !isTransientGitHubWarning(displayStatus.githubError) && (
            <div className="space-y-3 border border-destructive/30 bg-destructive/5 px-3 py-3">
              <div className="text-label font-medium uppercase tracking-wider text-destructive">
                仓库访问问题
              </div>
              <div className="space-y-2">
                {inaccessibleRepos.map((repoStatus) => (
                  <div key={repoStatus.repo} className="space-y-1">
                    <div className="text-label font-medium">
                      <a
                        href={`https://github.com/${repoStatus.repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        {repoStatus.repo}
                      </a>
                    </div>
                    <p className="text-body text-destructive">
                      无法访问此仓库： {repoStatus.error ?? "未知错误"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
