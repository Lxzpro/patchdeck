import { FormEvent, ReactNode, useEffect, useState } from "react";

interface AuthStatus {
  requiresLogin: boolean;
  loginConfigured: boolean;
  authenticated: boolean;
  username: string | null;
}

interface WebLoginGateProps {
  children: ReactNode;
}

function getErrorMessage(responseText: string, fallback: string): string {
  try {
    const parsed = JSON.parse(responseText) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    return responseText || fallback;
  }

  return responseText || fallback;
}

export function WebLoginGate({ children }: WebLoginGateProps) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/status")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return await response.json() as AuthStatus;
      })
      .then((nextStatus) => {
        if (!cancelled) {
          setStatus(nextStatus);
        }
      })
      .catch((authError: unknown) => {
        if (!cancelled) {
          const message = authError instanceof Error ? authError.message : "";
          setError(getErrorMessage(message, "无法检查登录状态。"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });
      const responseText = await response.text();

      if (!response.ok) {
        setError(getErrorMessage(responseText, "登录失败。"));
        return;
      }

      setPassword("");
      try {
        setStatus(JSON.parse(responseText) as AuthStatus);
      } catch {
        setError(getErrorMessage(responseText, "登录失败。"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
        <div className="border border-border px-4 py-3 text-body uppercase text-muted-foreground">
          {error ?? "正在加载 PatchDeck"}
        </div>
      </div>
    );
  }

  if (!status.requiresLogin || status.authenticated) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form
        className="w-full max-w-sm border border-border bg-card p-5"
        onSubmit={submitLogin}
      >
        <div className="mb-5 space-y-1">
          <p className="text-label uppercase text-muted-foreground">远程访问</p>
          <h1 className="text-title font-semibold">登录 PatchDeck</h1>
        </div>

        {!status.loginConfigured ? (
          <div className="border border-warning-border bg-warning-muted p-3 text-body text-warning-foreground">
            此服务尚未配置远程登录。
          </div>
        ) : (
          <>
            <label className="mb-3 block text-body">
              <span className="mb-1 block text-muted-foreground">用户名</span>
              <input
                className="w-full border border-input bg-background px-3 py-2 text-body text-foreground outline-none focus:border-ring"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>

            <label className="mb-4 block text-body">
              <span className="mb-1 block text-muted-foreground">密码</span>
              <input
                className="w-full border border-input bg-background px-3 py-2 text-body text-foreground outline-none focus:border-ring"
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {error && (
              <div className="mb-4 border border-destructive bg-background p-3 text-body text-destructive">
                {error}
              </div>
            )}

            <button
              className="w-full border border-primary bg-primary px-3 py-2 text-body font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={submitting}
              type="submit"
            >
              {submitting ? "正在登录" : "登录"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
