import type { RuntimeState } from "@shared/schema";

type DrainStatusView = {
  label: string;
  className: string;
};

export function getDrainStatusView(
  runtimeState: RuntimeState | undefined,
  isError: boolean,
): DrainStatusView {
  if (runtimeState?.drainMode) {
    return { label: "已暂停", className: "text-destructive" };
  }

  if (runtimeState) {
    return { label: "运行中", className: "text-muted-foreground" };
  }

  if (isError) {
    return { label: "无法获取", className: "text-destructive" };
  }

  return { label: "正在加载…", className: "text-muted-foreground" };
}

export function getDrainActionLabel(runtimeState: RuntimeState | undefined): string {
  return runtimeState?.drainMode ? "恢复" : "暂停";
}
