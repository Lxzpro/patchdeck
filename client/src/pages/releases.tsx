import { formatStatusLabel } from "@/lib/displayLabels";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { apiRequest, fetchJson, queryClient } from "@/lib/queryClient";
import { AppHeader } from "@/components/AppHeader";
import { GitHubReleaseCard } from "@/components/GitHubReleaseCard";
import { SocialPostGenerator } from "@/components/SocialPostGenerator";
import { UpdateBanner } from "@/components/UpdateBanner";
import { toast } from "@/hooks/use-toast";
import type { GitHubRelease, ReleasePreview, ReleaseRun, RepoGitHubReleases, RuntimeState } from "@shared/schema";

type ReleaseRunStatus = ReleaseRun["status"];

const ACTIVE_RELEASE_STATUSES = new Set<ReleaseRun["status"]>([
  "detected",
  "evaluating",
  "proposed",
  "publishing",
]);

function isActiveStatus(status: ReleaseRunStatus): boolean {
  return ACTIVE_RELEASE_STATUSES.has(status);
}

function isTerminalStatus(status: ReleaseRunStatus): boolean {
  return status === "published" || status === "skipped" || status === "error";
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return date.toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "暂无";
  return sha.slice(0, 7);
}

function StatusBadge({ status }: { status: ReleaseRunStatus }) {
  const cls = status === "published"
    ? "border-success-border bg-success-muted text-success-foreground"
    : status === "skipped"
      ? "border-border text-muted-foreground"
      : status === "error"
        ? "border-destructive bg-destructive/10 text-destructive"
        : isActiveStatus(status)
          ? "border-primary bg-primary/10 text-primary animate-pulse"
          : "border-border text-muted-foreground";

  return (
    <span className={`rounded-md border px-1.5 py-0 text-label font-medium uppercase tracking-wider ${cls}`}>
      {formatStatusLabel(status)}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法写入剪贴板";
      toast({ variant: "destructive", description: `复制失败：${message}` });
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-0.5 text-label font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function ReleasePreviewPanel({
  preview,
  loading,
}: {
  preview?: ReleasePreview;
  loading: boolean;
}) {
  if (loading && !preview) {
    return (
      <div className="mb-4 rounded-md border border-border px-4 py-3 text-body text-muted-foreground">
        正在加载发布预览…
      </div>
    );
  }

  if (!preview) return null;

  if (preview.state === "empty") {
    return (
      <div className="mb-4 rounded-md border border-border px-4 py-3" data-testid="release-readiness-preview">
        <div className="text-label font-medium uppercase tracking-wider text-muted-foreground">发布预览</div>
        <div className="mt-1 text-body text-muted-foreground">
          以下仓库没有待发布的已合并 PR： <span className="font-mono text-foreground">{preview.repo}</span>.
        </div>
      </div>
    );
  }

  return (
    <section className="mb-4 rounded-md border border-border px-4 py-3" data-testid="release-readiness-preview">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-label font-medium uppercase tracking-wider text-muted-foreground">发布预览</div>
          <a
            href={preview.triggerPr?.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block text-body font-medium text-foreground hover:text-primary"
          >
            下次触发：#{preview.triggerPr?.number} {preview.triggerPr?.title}
          </a>
        </div>
        <div className="text-right font-mono text-label text-muted-foreground">
          <div>基础版本 {preview.baseBranch}</div>
          <div>最新版本 {preview.latestTag ?? "无"}</div>
        </div>
      </div>

      {preview.candidateVersions && (
        <div className="mt-3 flex flex-wrap gap-2">
          {(["patch", "minor", "major"] as const).map((bump) => (
            <span key={bump} className="rounded-md border border-border px-2 py-1 text-label uppercase tracking-wider text-muted-foreground">
              {bump} <span className="font-mono text-foreground">{preview.candidateVersions?.[bump]}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 grid gap-1 text-label">
        <div className="text-label uppercase tracking-wider text-muted-foreground">
          包含的 PR <span className="font-mono text-foreground">{preview.includedPrs.length}</span>
        </div>
        {preview.includedPrs.slice(0, 6).map((pr) => (
          <a key={`${pr.number}-${pr.mergeSha}`} href={pr.url} target="_blank" rel="noreferrer" className="truncate text-muted-foreground hover:text-foreground">
            <span className="font-mono">#{pr.number}</span> {pr.title}
          </a>
        ))}
        {preview.includedPrs.length > 6 && (
          <div className="text-muted-foreground">+{preview.includedPrs.length - 6} 个其他 PR</div>
        )}
      </div>

      <div className="mt-3 text-label text-muted-foreground">
        {preview.existingRunId
          ? `现有发布任务 ${preview.existingRunId.slice(0, 8)} 的状态为 ${formatStatusLabel(preview.existingRunStatus ?? "未知")}。`
          : "手动发布会先评估此候选版本，再决定是否发布。"}
      </div>
    </section>
  );
}

function ReleaseRunCard({
  run,
  githubRelease,
  onRetry,
  retryPending,
}: {
  run: ReleaseRun;
  githubRelease?: GitHubRelease;
  onRetry: (id: string) => void;
  retryPending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails =
    Boolean(run.decisionReason) ||
    Boolean(run.releaseTitle) ||
    Boolean(run.releaseNotes) ||
    Boolean(run.error) ||
    Boolean(run.githubReleaseUrl) ||
    Boolean(githubRelease) ||
    run.includedPrs.length > 0;
  const shouldShowEmptyDetails =
    !hasDetails
    && isTerminalStatus(run.status);
  const detailsId = `release-run-${run.id}-details`;

  return (
    <div className="border border-border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls={detailsId}
      >
        <div className="flex min-w-0 items-center gap-3">
          <StatusBadge status={run.status} />
          <span className="truncate text-body font-medium">{run.repo}</span>
          <span className="font-mono text-label text-muted-foreground">#{run.triggerPrNumber}</span>
          {run.proposedVersion && (
            <span className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0 font-mono text-label font-medium uppercase tracking-wider text-primary">
              {run.proposedVersion}
            </span>
          )}
          {!run.proposedVersion && run.recommendedBump && (
            <span className="text-label text-muted-foreground">
              版本升级 {run.recommendedBump}
            </span>
          )}
          {githubRelease && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-success-border bg-success-muted px-1.5 py-0 text-label font-medium uppercase tracking-wider text-success-foreground"
              title={`已关联 GitHub 发布 ${githubRelease.tagName}`}
              data-testid={`github-link-${run.id}`}
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
              在 GitHub 上查看
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-label text-muted-foreground">
          <span>{formatDateTime(run.createdAt)}</span>
          <span>{expanded ? "隐藏" : "显示"}</span>
        </div>
      </button>

      {expanded && (
        <div id={detailsId} className="border-t border-border px-4 pb-4 pt-3">
          <div className="mb-3 text-body text-muted-foreground">
            触发 PR：{" "}
            <a href={run.triggerPrUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background">
              #{run.triggerPrNumber} {run.triggerPrTitle}
            </a>
          </div>

          {run.decisionReason && (
            <p className="mb-3 text-body leading-relaxed">{run.decisionReason}</p>
          )}

          {run.releaseTitle && (
            <p className="mb-3 text-body">
              <span className="text-muted-foreground">发布标题：</span>{" "}
              <span>{run.releaseTitle}</span>
            </p>
          )}

          <div className="mb-3 grid grid-cols-1 gap-2 text-body text-muted-foreground md:grid-cols-2">
            <div>基础分支： {run.baseBranch || "n/a"}</div>
            <div>触发提交 SHA： {shortSha(run.triggerMergeSha)}</div>
            <div>合并时间： {formatDateTime(run.triggerMergedAt)}</div>
            <div>更新时间： {formatDateTime(run.updatedAt)}</div>
          </div>

          {run.includedPrs.length > 0 && (
            <div className="mb-3">
              <div className="mb-1.5 text-label uppercase tracking-wider text-muted-foreground">
                包含的 PR（{run.includedPrs.length})
              </div>
              <div className="space-y-1 border border-border p-3 text-body">
                {run.includedPrs.map((pr) => (
                  <div key={`${pr.mergeSha}-${pr.number}`} className="flex items-center justify-between gap-3">
                    <span className="truncate">
                      #{pr.number} {pr.title}
                    </span>
                    <a href={pr.url} target="_blank" rel="noreferrer noopener" className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background">
                      未关闭
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {run.releaseNotes && (
            <div className="mb-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-label uppercase tracking-wider text-muted-foreground">发布说明</span>
                <CopyButton text={run.releaseNotes} />
              </div>
              <pre className="whitespace-pre-wrap border border-border bg-background p-3 text-body leading-relaxed font-mono">
                {run.releaseNotes}
              </pre>
            </div>
          )}

          {run.error && (
            <div className="mb-3 border border-destructive/40 bg-destructive/5 p-3 text-body text-destructive">
              {run.error}
            </div>
          )}

          {githubRelease && (
            <div className="mb-3 rounded-md border border-success-border bg-success-muted/40 px-3 py-2 text-body">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label">
                <span className="text-label font-medium uppercase tracking-wider text-success-foreground">
                  关联的 GitHub 发布
                </span>
                <span className="text-border" aria-hidden="true">·</span>
                <span className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0 font-mono text-label font-medium uppercase tracking-wider text-primary">
                  {githubRelease.tagName}
                </span>
                {githubRelease.publishedAt && (
                  <>
                    <span className="text-border" aria-hidden="true">·</span>
                    <span className="text-muted-foreground">
                      已发布 <span className="font-mono">{formatDateTime(githubRelease.publishedAt)}</span>
                    </span>
                  </>
                )}
              </div>
              {githubRelease.name && (
                <div className="mt-1 truncate text-body font-medium">{githubRelease.name}</div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {(githubRelease?.htmlUrl || run.githubReleaseUrl) && (
              <a
                href={githubRelease?.htmlUrl ?? run.githubReleaseUrl ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-label font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                <ExternalLink className="h-3 w-3" />
                在 GitHub 上打开
              </a>
            )}
            {run.status === "error" && (
              <button
                type="button"
                onClick={() => onRetry(run.id)}
                disabled={retryPending}
                className="cursor-pointer rounded-md border border-primary bg-primary px-3 py-1 text-label font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
              >
                重试
              </button>
            )}
          </div>

          {shouldShowEmptyDetails && (
            <p className="mt-2 text-body text-muted-foreground">暂无详情。</p>
          )}

          <SocialPostGenerator
            testIdPrefix={`release-run-${run.id}`}
            request={{ kind: "internal", releaseRunId: run.id }}
          />
        </div>
      )}
    </div>
  );
}

function RepoListButton({
  repo,
  count,
  selected,
  onSelect,
}: {
  repo: string;
  count: number;
  selected: boolean;
  onSelect: (repo: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(repo)}
      data-testid={`releases-repo-${repo.replace("/", "-")}`}
      className={`flex w-full cursor-pointer items-center justify-between gap-3 border-b border-l-2 border-border px-4 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
        selected
          ? "border-l-primary bg-muted"
          : "border-l-transparent hover:bg-muted/30"
      }`}
    >
      <span className="min-w-0 truncate text-body text-foreground">{repo}</span>
      <span className={`shrink-0 font-mono text-label ${selected ? "text-primary" : "text-muted-foreground"}`}>
        {count}
      </span>
    </button>
  );
}

export default function Releases() {
  const { data: releases = [], isLoading } = useQuery<ReleaseRun[]>({
    queryKey: ["/api/releases"],
    staleTime: 5 * 60 * 1000,
  });

  const { data: runtimeState } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 5000,
  });

  const {
    data: githubReleasesByRepo = [],
    isFetching: isFetchingGitHub,
    error: githubError,
  } = useQuery<RepoGitHubReleases[]>({
    queryKey: ["/api/github-releases"],
    enabled: runtimeState !== undefined,
    staleTime: 5 * 60 * 1000,
  });

  const { releaseLookup, orphans } = useMemo(() => {
    const lookup = new Map<string, GitHubRelease>();
    const linkedIds = new Set<string>();

    for (const entry of githubReleasesByRepo) {
      for (const release of entry.releases) {
        lookup.set(`${entry.repo}:${release.id}`, release);
      }
    }

    for (const run of releases) {
      if (run.githubReleaseId !== null && run.githubReleaseId !== undefined) {
        linkedIds.add(`${run.repo}:${run.githubReleaseId}`);
      }
    }

    const orphanList: Array<{ repo: string; release: GitHubRelease }> = [];
    for (const entry of githubReleasesByRepo) {
      for (const release of entry.releases) {
        const key = `${entry.repo}:${release.id}`;
        if (!linkedIds.has(key)) {
          orphanList.push({ repo: entry.repo, release });
        }
      }
    }

    orphanList.sort((a, b) => {
      const aTime = a.release.publishedAt ? Date.parse(a.release.publishedAt) : 0;
      const bTime = b.release.publishedAt ? Date.parse(b.release.publishedAt) : 0;
      return bTime - aTime;
    });

    return { releaseLookup: lookup, orphans: orphanList };
  }, [releases, githubReleasesByRepo]);

  const repoList = useMemo(() => {
    const names = new Set<string>();
    for (const entry of githubReleasesByRepo) names.add(entry.repo);
    for (const run of releases) names.add(run.repo);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [githubReleasesByRepo, releases]);

  const runsByRepo = useMemo(() => {
    const map = new Map<string, ReleaseRun[]>();
    for (const run of releases) {
      const list = map.get(run.repo) ?? [];
      list.push(run);
      map.set(run.repo, list);
    }
    return map;
  }, [releases]);

  const orphansByRepo = useMemo(() => {
    const map = new Map<string, GitHubRelease[]>();
    for (const { repo, release } of orphans) {
      const list = map.get(repo) ?? [];
      list.push(release);
      map.set(repo, list);
    }
    return map;
  }, [orphans]);

  const repoCount = useCallback(
    (repo: string) => (runsByRepo.get(repo)?.length ?? 0) + (orphansByRepo.get(repo)?.length ?? 0),
    [orphansByRepo, runsByRepo],
  );

  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  useEffect(() => {
    if (repoList.length === 0) {
      if (selectedRepo !== null) setSelectedRepo(null);
      return;
    }
    if (selectedRepo && repoList.includes(selectedRepo)) return;
    const firstWithActivity = repoList.find((repo) => repoCount(repo) > 0);
    setSelectedRepo(firstWithActivity ?? repoList[0]);
  }, [repoCount, repoList, selectedRepo]);

  const selectedRuns = selectedRepo ? runsByRepo.get(selectedRepo) ?? [] : [];
  const selectedOrphans = selectedRepo ? orphansByRepo.get(selectedRepo) ?? [] : [];
  const { data: releasePreview, isFetching: isFetchingReleasePreview } = useQuery<ReleasePreview>({
    queryKey: ["/api/repos/release-preview", selectedRepo],
    enabled: Boolean(selectedRepo) && runtimeState !== undefined,
    queryFn: async () => fetchJson<ReleasePreview>(`/api/repos/release-preview?repo=${encodeURIComponent(selectedRepo ?? "")}`),
    staleTime: 5 * 60 * 1000,
  });

  const handleSyncGitHub = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/github-releases"] });
    queryClient.invalidateQueries({ queryKey: ["/api/releases"] });
  };

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/releases/${id}/retry`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/releases"] });
      toast({ description: "已安排重试。" });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `重试失败：${error.message}` });
    },
  });

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <UpdateBanner />
      <AppHeader
        active="releases"
        status={(
          releases.length > 0 || orphans.length > 0 ? (
            <span>
              <span className="font-mono text-foreground">{releases.length}</span> 流水线 / <span className="font-mono text-foreground">{orphans.length}</span> 外部发布
            </span>
          ) : null
        )}
      />

      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        {/* Sidebar: repo list */}
        <aside className="flex max-h-[42vh] w-full shrink-0 flex-col overflow-hidden border-b border-border lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
            <span className="text-label font-medium uppercase tracking-wider text-muted-foreground">
              关注的仓库
            </span>
            <button
              type="button"
              onClick={handleSyncGitHub}
              disabled={isFetchingGitHub || runtimeState === undefined}
              title={isFetchingGitHub ? "正在同步…" : "从 GitHub 同步"}
              aria-label={isFetchingGitHub ? "正在从 GitHub 同步" : "从 GitHub 同步"}
              data-testid="button-sync-github-releases"
              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-primary bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isFetchingGitHub ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {isLoading && repoList.length === 0 ? (
              <div className="p-4 text-body text-muted-foreground">正在加载…</div>
            ) : repoList.length === 0 ? (
              <div className="p-4 text-body text-muted-foreground">
                尚未关注仓库，请在设置中添加。
              </div>
            ) : (
              repoList.map((repo) => (
                <RepoListButton
                  key={repo}
                  repo={repo}
                  count={repoCount(repo)}
                  selected={repo === selectedRepo}
                  onSelect={setSelectedRepo}
                />
              ))
            )}
          </div>
        </aside>

        {/* Content: selected repo's releases */}
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {githubError && (
            <div className="mx-6 mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
              <div className="text-label font-medium uppercase tracking-wider">GitHub 同步错误</div>
              <div className="mt-1 whitespace-pre-wrap break-words">
                {githubError instanceof Error ? githubError.message : String(githubError)}
              </div>
            </div>
          )}

          {!selectedRepo ? (
            <div className="flex flex-1 items-center justify-center p-6 text-body text-muted-foreground">
              {isLoading ? "正在加载…" : "从左侧选择仓库以查看发布记录。"}
            </div>
          ) : (
            <div className="p-6">
	              <div className="mb-4 flex items-baseline justify-between">
	                <h2 className="text-title font-semibold tracking-tight">{selectedRepo}</h2>
	                <span className="font-mono text-label text-muted-foreground">
	                  {selectedRuns.length} 流水线 · {selectedOrphans.length} 外部发布
	                </span>
	              </div>

	              <ReleasePreviewPanel preview={releasePreview} loading={isFetchingReleasePreview} />

	              {selectedRuns.length === 0 && selectedOrphans.length === 0 ? (
                <div className="rounded-md border border-border px-4 py-8 text-center">
                  <p className="text-body text-muted-foreground">暂无发布活动。</p>
                  <p className="mt-1 text-body text-muted-foreground">
                    评估已合并的 PR 后会显示发布流水线记录；从 GitHub 同步后会显示发布版本。
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-6">
                  {selectedRuns.length > 0 && (
                    <section>
                      <div className="mb-2 flex items-baseline justify-between">
                        <h3 className="text-label font-medium uppercase tracking-wider text-muted-foreground">
                          发布流水线
                        </h3>
                        <span className="font-mono text-label text-muted-foreground">
                          {selectedRuns.length}
                        </span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {selectedRuns.map((run) => {
                          const linked = run.githubReleaseId !== null && run.githubReleaseId !== undefined
                            ? releaseLookup.get(`${run.repo}:${run.githubReleaseId}`)
                            : undefined;
                          return (
                            <ReleaseRunCard
                              key={run.id}
                              run={run}
                              githubRelease={linked}
                              onRetry={(id) => retryMutation.mutate(id)}
                              retryPending={retryMutation.isPending}
                            />
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {selectedOrphans.length > 0 && (
                    <section>
                      <div className="mb-2 flex items-baseline justify-between">
                        <h3 className="text-label font-medium uppercase tracking-wider text-muted-foreground">
                          流水线外发布
                        </h3>
                        <span className="font-mono text-label text-muted-foreground">
                          {selectedOrphans.length}
                        </span>
                      </div>
                      <p className="mb-3 text-label text-muted-foreground">
                        这些 GitHub 发布没有对应的内部任务，可能由手动创建，或早于开始监控的时间。
                      </p>
                      <div className="flex flex-col gap-2">
                        {selectedOrphans.map((release) => (
                          <GitHubReleaseCard key={release.id} release={release} repoSlug={selectedRepo} />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
