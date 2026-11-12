import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import test from "node:test";
import { Router } from "wouter";
import NotFound from "../pages/not-found";
import Dashboard from "../pages/dashboard";
import PRs from "../pages/prs";
import Issues from "../pages/issues";
import Releases from "../pages/releases";
import Deployments from "../pages/deployments";
import Settings from "../pages/settings";
import Logs from "../pages/logs";
import { formatFeedbackStatusLabel } from "./feedbackStatus";
import { formatCurrentRunStatus, formatIssueWorkStage, formatPRWorkState } from "./statusCopy";

function renderPage(page: React.ComponentType): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => null } } });
  client.setQueryData(["/api/prs"], []);
  const globals = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = globals.React;
  // Node uses classic JSX for these files; Vite supplies the JSX runtime in the app.
  globals.React = React;
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client },
        createElement(Router, { ssrPath: "/" }, createElement(page)),
      ),
    );
  } finally {
    client.clear();
    if (previousReact) globals.React = previousReact;
    else delete globals.React;
  }
}

test("the interface renders Chinese navigation and empty-page guidance", () => {
  const html = renderPage(NotFound);
  for (const text of ["总览", "议题", "发布", "部署", "日志", "设置", "页面不存在"]) {
    assert.ok(html.includes(text), `Missing Chinese interface text: ${text}`);
  }
  assert.ok(html.includes('href="/prs"'), "PR navigation keeps its existing route");
});

test("work and feedback states use Chinese without changing API status values", () => {
  assert.equal(formatPRWorkState("processing", "tests"), "正在验证检查");
  assert.equal(formatPRWorkState("done"), "处理完成");
  assert.equal(formatCurrentRunStatus("running"), "运行中");
  assert.equal(formatIssueWorkStage({ workStage: "opening_pr", workStatus: "in_progress" }), "正在创建 PR");
  assert.equal(formatFeedbackStatusLabel("in_progress"), "处理中");
  assert.equal(formatFeedbackStatusLabel("rejected"), "已拒绝");
});

test("status labels translate known values and preserve unknown diagnostic values", async () => {
  const { formatStatusLabel } = await import("./displayLabels");
  assert.equal(formatStatusLabel("needs_review"), "待人工审核");
  assert.equal(formatStatusLabel("fix_submitted"), "修复已提交");
  assert.equal(formatStatusLabel("babysit_pr"), "处理 PR");
  assert.equal(formatStatusLabel("custom-check-name"), "custom-check-name");
});

test("PR pipeline labels preserve completed stage progress", async () => {
  const { buildPRStages } = await import("./stages");
  const stages = buildPRStages({ status: "done" });
  assert.ok(stages.every((stage) => stage.state === "done"));
  assert.equal(stages.at(-1)?.label, "完成");
});


for (const [page, text] of [
  [Dashboard, "关注的仓库"],
  [PRs, "尚未跟踪 PR"],
  [Issues, "关注的议题"],
  [Releases, "关注的仓库"],
  [Deployments, "部署修复会话"],
  [Settings, "关注来源"],
  [Logs, "实时跟踪"],
] as const) {
  test(`${page.name} renders its Chinese interface`, () => {
    const html = renderPage(page);
    assert.ok(html.includes(text), `Missing Chinese page text: ${text}`);
    assert.ok(!html.includes("仓库s"), "Chinese counts have no English plural suffix");
  });
}
