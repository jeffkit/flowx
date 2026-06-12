# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- 文档站（VitePress）：首页、快速上手、核心概念、L3 编排、配置分层、示例、API 参考，
  以及《从零到第一次跑通》《排错 / FAQ》《给 AI 使用》页与 `/llms.txt` 单页速查。
- `skills/flowx/SKILL.md`：随仓发布的 flowx skill，给"使用 flowx 的 AI"一份触发词 +
  最小 bootstrap + 能力词汇表 + 排错对照 + 决策树。
- 发布脚手架：`.github/workflows/publish.yml`（打 `v*` tag → `npm publish --provenance`）。

## [0.1.0]

首个版本。

### 新增
- **L2 引擎原语**：`Checkpoint`（断点续跑）、`withSelfModGuard` / `captureBaseline`（自改安全沙箱）、
  `runGate` / `runGates`（质量门）、`writeFailureContext`（失败上下文）、可插拔 HITL（terminal / wecom）、`isDryRun`。
- **L1 执行器**：`runAgent` + claude / cursor / gemini / codex / aider / recursive / agy adapter；
  `runAgentChain`（跨 CLI 限额回退 + 自适应冷却）；`parallel` / `pipeline`。
- **配置分层**：`provider.js`（`${VAR}` 插值 + 多层加载 + `resolveProvider`）、
  `executor.js`（执行器能力分层 + `resolveAgent` 绑定校验）。
- **受控 git 原语**：`gitStatus` / `gitDiff` / `gitCommitAll` / `gitCreateBranch` / `gitWorktreeAdd` / `gitWorktreeRemove` 等。
- **子 flow 调度**：`runFlow`（隔离子进程）、`fanOut`（限并发 + worktree 隔离 + per-task 日志 + 汇总）。
- **L3 codegen 编排**：`orchestrate` / `orchestrateMulti`、`generateFlow` / `validateFlow`、`decompose`，
  CLI `flowx orchestrate [--split]`，护栏三件套（约束式生成 / 跑前校验 / 持久化+续跑锁定）。
- **可观测看板**：`collectRuns` / `renderHtml` / `generateDashboard`，CLI `flowx dashboard`。

[Unreleased]: https://github.com/jeffkit/flowx/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jeffkit/flowx/releases/tag/v0.1.0
