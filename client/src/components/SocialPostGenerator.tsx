import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Sparkles } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { ReleaseSocialPost, StartReleaseSocialPostRequest } from "@shared/schema";

const POLL_INTERVAL_MS = 2000;

function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard failures
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-label font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}

export function SocialPostGenerator({
  request,
  testIdPrefix,
}: {
  request: StartReleaseSocialPostRequest;
  testIdPrefix: string;
}) {
  const [post, setPost] = useState<ReleaseSocialPost | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollJob = async (jobId: string) => {
    try {
      const res = await apiRequest("GET", `/api/releases/social-post/${jobId}`);
      const next = (await res.json()) as ReleaseSocialPost;
      setPost(next);
      if (next.status === "generating") {
        pollRef.current = setTimeout(() => pollJob(jobId), POLL_INTERVAL_MS);
      } else {
        stopPolling();
      }
    } catch (err) {
      stopPolling();
      setStartError(err instanceof Error ? err.message : "无法获取生成状态");
    }
  };

  const handleGenerate = async () => {
    stopPolling();
    setStartError(null);
    setStarting(true);
    setPost(null);
    try {
      const res = await apiRequest("POST", "/api/releases/social-post", request);
      const initial = (await res.json()) as ReleaseSocialPost;
      setPost(initial);
      if (initial.status === "generating") {
        pollRef.current = setTimeout(() => pollJob(initial.jobId), POLL_INTERVAL_MS);
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "无法启动生成任务");
    } finally {
      setStarting(false);
    }
  };

  const status = post?.status;
  const buttonLabel =
    starting ? "正在启动…"
      : status === "generating" ? "正在生成…"
        : status === "done" ? "重新生成"
          : "生成文案";

  const busy = starting || status === "generating";

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-label text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span className="font-medium uppercase tracking-wider">社交发布文案</span>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={busy}
          data-testid={`${testIdPrefix}-generate-social-post`}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1 text-label font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {buttonLabel}
        </button>
      </div>

      {startError && (
        <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-label text-destructive">
          {startError}
        </div>
      )}

      {post?.status === "error" && post.error && (
        <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-label text-destructive">
          <div className="text-label font-medium uppercase tracking-wider">生成失败</div>
          <div className="mt-1 whitespace-pre-wrap break-words">{post.error}</div>
        </div>
      )}

      {post?.status === "generating" && (
        <div className="mt-2 text-label text-muted-foreground">
          正在生成发布文案，可能需要 30–120 秒。
        </div>
      )}

      {post?.status === "done" && (
        <div className="mt-3 grid gap-3">
          {post.twitter && (
            <section
              className="rounded-md border border-border bg-muted/20 p-3"
              data-testid={`${testIdPrefix}-social-twitter`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-label font-medium uppercase tracking-wider text-muted-foreground">
                  Twitter / X
                </span>
                <CopyChip text={post.twitter} />
              </div>
              <pre className="whitespace-pre-wrap break-words text-body leading-relaxed text-foreground/85">
                {post.twitter}
              </pre>
            </section>
          )}
          {post.linkedin && (
            <section
              className="rounded-md border border-border bg-muted/20 p-3"
              data-testid={`${testIdPrefix}-social-linkedin`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-label font-medium uppercase tracking-wider text-muted-foreground">
                  LinkedIn
                </span>
                <CopyChip text={post.linkedin} />
              </div>
              <pre className="whitespace-pre-wrap break-words text-body leading-relaxed text-foreground/85">
                {post.linkedin}
              </pre>
            </section>
          )}
          {!post.twitter && !post.linkedin && post.raw && (
            <section className="rounded-md border border-border bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-label font-medium uppercase tracking-wider text-muted-foreground">
                  原始输出
                </span>
                <CopyChip text={post.raw} />
              </div>
              <pre className="whitespace-pre-wrap break-words text-body leading-relaxed text-foreground/85">
                {post.raw}
              </pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
