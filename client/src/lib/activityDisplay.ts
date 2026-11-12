const TASK_PREFIXES: Array<[RegExp, string]> = [
  [/^(?:Babysitting|Working) PR\b/, "处理 PR"],
  [/^Working issue\b/, "处理议题"],
  [/^Evaluating issue\b/, "评估议题"],
  [/^Verifying issue\b/, "验证议题"],
  [/^Answering question for PR\b/, "回答 PR 问题"],
  [/^Processing release for\b/, "处理仓库发布"],
  [/^Sync watched repositories\b/, "同步关注的仓库"],
  [/^Healing (.+) deployment\b/, "修复 $1 部署"],
];

export function formatActivityLabel(label: string): string {
  for (const [pattern, translation] of TASK_PREFIXES) {
    if (pattern.test(label)) return label.replace(pattern, translation);
  }
  return label;
}

export function formatActivityDetail(detail: string | null): string | null {
  return detail?.replace(/Refilling (?:babysitter|PR work) queue/, "补充 PR 处理队列") ?? null;
}
