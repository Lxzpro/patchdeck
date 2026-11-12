import type { Config, HealingSession, HealingSessionState } from "@shared/schema";

export type HealingOperatorAction = "pause" | "resume" | "retry" | "cancel";
export type HealingViewTone = "neutral" | "info" | "warning" | "success" | "danger";

export type HealingSessionActionView = {
  label: string;
  available: boolean;
  hint: string;
};

export type HealingSessionView = {
  stateLabel: string;
  tone: HealingViewTone;
  attemptSummary: string;
  reasonSummary: string | null;
  statusHint: string;
  actions: HealingSessionActionView[];
};

const HEALING_STATE_LABELS: Record<HealingSessionState, string> = {
  idle: "空闲",
  triaging: "正在评估",
  awaiting_repair_slot: "修复排队中",
  repairing: "修复中",
  awaiting_ci: "等待 CI",
  verifying: "验证中",
  healed: "已修复",
  cooldown: "冷却中",
  blocked: "已阻塞",
  escalated: "需人工处理",
  superseded: "已被替代",
};

const HEALING_BADGE_CLASSES: Record<HealingSessionState, string> = {
  idle: "border-border text-muted-foreground",
  triaging: "border-foreground/30 text-foreground/80 bg-muted/40",
  awaiting_repair_slot: "border-warning-border text-warning-foreground bg-warning-muted",
  repairing: "border-foreground/30 text-foreground bg-muted/70",
  awaiting_ci: "border-foreground/30 text-foreground bg-muted/70",
  verifying: "border-foreground/30 text-foreground bg-muted/70",
  healed: "border-success-border text-success-foreground bg-success-muted",
  cooldown: "border-warning-border text-warning-foreground bg-warning-muted",
  blocked: "border-destructive/40 text-destructive bg-destructive/10",
  escalated: "border-destructive/40 text-destructive bg-destructive/10",
  superseded: "border-border text-muted-foreground bg-muted/40",
};

const HEALING_OPERATOR_ACTIONS: Record<HealingSessionState, HealingOperatorAction[]> = {
  idle: [],
  triaging: ["cancel"],
  awaiting_repair_slot: ["pause", "cancel"],
  repairing: ["pause", "cancel"],
  awaiting_ci: ["pause", "cancel"],
  verifying: ["cancel"],
  healed: [],
  cooldown: ["resume", "cancel"],
  blocked: ["retry"],
  escalated: ["retry"],
  superseded: [],
};

const HEALING_VIEW_TONES: Record<HealingSessionState, HealingViewTone> = {
  idle: "neutral",
  triaging: "info",
  awaiting_repair_slot: "warning",
  repairing: "info",
  awaiting_ci: "info",
  verifying: "info",
  healed: "success",
  cooldown: "warning",
  blocked: "danger",
  escalated: "danger",
  superseded: "neutral",
};

const HEALING_STATUS_HINTS: Record<HealingSessionState, string> = {
  idle: "等待当前 PR 提交出现新的检查失败。",
  triaging: "正在分析失败原因，判断是否可以安全修复。",
  awaiting_repair_slot: "已准备好下一次修复，等待空闲执行名额。",
  repairing: "修复代理正在隔离 worktree 中工作。",
  awaiting_ci: "修复已推送，正在等待新提交的 CI 结果。",
  verifying: "正在对照之前的故障特征验证最新检查结果。",
  healed: "最新修复已通过检查，此会话已完成。",
  cooldown: "正在冷却，稍后允许重试。",
  blocked: "失败可能来自外部环境，或不适合在分支内修复，已停止处理。",
  escalated: "重试次数已用尽或故障未改善，已停止处理。",
  superseded: "PR 已更新到新的提交，此会话已被替代。",
};

export function formatHealingSessionStateLabel(state: HealingSessionState): string {
  return HEALING_STATE_LABELS[state];
}

export function getHealingSessionBadgeClass(state: HealingSessionState): string {
  return HEALING_BADGE_CLASSES[state];
}

export function getHealingSessionOperatorActions(
  state: HealingSessionState,
): HealingOperatorAction[] {
  return HEALING_OPERATOR_ACTIONS[state];
}

export function formatHealingOperatorActionLabel(action: HealingOperatorAction): string {
  if (action === "pause") {
    return "暂停";
  }

  if (action === "resume") {
    return "恢复";
  }

  if (action === "retry") {
    return "重试";
  }

  return "取消";
}

export function getHealingSessionTone(state: HealingSessionState): HealingViewTone {
  return HEALING_VIEW_TONES[state];
}

export function getHealingSessionStatusHint(state: HealingSessionState): string {
  return HEALING_STATUS_HINTS[state];
}

export function summarizeHealingAttemptProgress(
  session: Pick<HealingSession, "state" | "attemptCount">,
): string {
  const attempts = session.attemptCount;

  if (attempts === 0) {
    if (session.state === "triaging") {
      return "正在准备第 1 次尝试";
    }

    if (session.state === "awaiting_repair_slot") {
      return "第 1 次尝试已排队";
    }

    if (session.state === "healed") {
      return "无需修复即已恢复";
    }

    return "尚未尝试修复";
  }

  if (session.state === "repairing") {
    return `第 ${attempts} 次尝试正在运行`;
  }

  if (session.state === "awaiting_ci") {
    return `第 ${attempts} 次尝试已推送，等待 CI`;
  }

  if (session.state === "verifying") {
    return `正在验证第 ${attempts} 次尝试`;
  }

  if (session.state === "healed") {
    return `尝试 ${attempts} 次后已修复`;
  }

  if (session.state === "blocked") {
    return `尝试 ${attempts} 次后受阻`;
  }

  if (session.state === "escalated") {
    return `尝试 ${attempts} 次后转人工处理`;
  }

  if (session.state === "cooldown") {
    return `已尝试 ${attempts} 次，冷却中`;
  }

  if (session.state === "superseded") {
    return `已尝试 ${attempts} 次，已被替代`;
  }

  return `已记录 ${attempts} 次尝试`;
}

export function getHealingSessionReason(
  session: Pick<HealingSession, "blockedReason" | "escalationReason" | "latestFingerprint"> | null | undefined,
): string | null {
  if (!session) {
    return null;
  }

  return session.blockedReason ?? session.escalationReason ?? session.latestFingerprint ?? null;
}

export function getLatestHealingSessionForPR(
  sessions: HealingSession[],
  prId: string,
): HealingSession | null {
  const matchingSessions = sessions.filter((session) => session.prId === prId);

  if (matchingSessions.length === 0) {
    return null;
  }

  return matchingSessions.reduce((latest, session) => {
    if (session.updatedAt > latest.updatedAt) {
      return session;
    }

    return latest;
  });
}

export function selectRelevantHealingSession(
  sessions: HealingSession[],
  prId: string,
): HealingSession | null {
  return getLatestHealingSessionForPR(sessions, prId);
}

export function getHealingSessionView(
  session: HealingSession,
  _config?: Pick<Config, "autoHealCI">,
): HealingSessionView {
  return {
    stateLabel: formatHealingSessionStateLabel(session.state),
    tone: getHealingSessionTone(session.state),
    attemptSummary: summarizeHealingAttemptProgress(session),
    reasonSummary: getHealingSessionReason(session),
    statusHint: getHealingSessionStatusHint(session.state),
    actions: getHealingSessionOperatorActions(session.state).map((action) => ({
      label: formatHealingOperatorActionLabel(action),
      available: true,
      hint: `“${formatHealingOperatorActionLabel(action)}”功能尚未接入后端。`,
    })),
  };
}
