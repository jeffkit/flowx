---
name: flowx
description: 用 flowx 把一个会多步骤、可能中断、需要人工确认或质量门把关的编码任务，固化成可断点续跑的 workflow，或用 L3 一行需求自动生成并执行 flow。当用户想"自动化某个开发/编排流程""让 agent 安全地改代码（含自改）""把一行需求端到端跑成受控 flow""用统一接口调度 claude/cursor/gemini/codex/aider/recursive 等多个 coding agent""并发跑多条子任务并隔离汇总"时使用。触发词：flowx、orchestrate、断点续跑 flow、写一个 flow、跑 workflow、质量门、自改沙箱、fanOut、HITL 编排、L3 编排、接单分拆。
---

# flowx：把任务固化成可续跑的受控 workflow

`@force-lab/flowx` 是轻量 workflow 编排框架（零运行时依赖 · 纯 ESM · Node ≥ 20）。
本 skill 教"使用 flowx 的 AI"如何最快把它用起来：先 bootstrap，再选对入口，照词汇表编排，撞错按对照表修。

> 完整文档站：https://jeffkit.github.io/flowx/ ；可塞进 context 的单页速查：https://jeffkit.github.io/flowx/llms.txt

## 0. 先判断：要不要用 flowx

用 flowx，当任务满足任意一条：
- 多步骤、**可能中断**、希望中断后能从断点续跑（不重做已完成步骤）。
- 需要 **HITL**（关键节点人工确认/通知）。
- 需要 **质量门**（测试/lint/构建把关）或**让 agent 安全改代码**（失败自动回滚）。
- 要**统一调度多个 coding agent**，或**并发跑多条子任务**并隔离汇总。
- 想把"一行需求"端到端**自动生成并执行**成可审计的 flow。

不要用 flowx 当：一次性单步问答、纯读代码、无中断风险的简单脚本。

## 1. Bootstrap（最小可用环境，照做一遍）

1) **Node ≥ 20**。确认 `node --version`。

2) **让目标仓能解析 `@force-lab/flowx`**（L3 生成的 flow 会 `import` 本包，缺它必失败）。
   已发布到 npm 后：`npm install @force-lab/flowx`；否则用源码 + file: 依赖：
   ```bash
   git clone https://github.com/jeffkit/flowx.git ~/projects/flowx
   cd <目标仓> && npm install ~/projects/flowx
   ```

3) **机器级配置**（密钥永不入仓，用 `${ENV}` 运行时插值）：
   `~/.flowx/providers.json`
   ```json
   { "providers": {
     "deepseek": { "type": "openai", "apiBase": "https://api.deepseek.com/v1", "model": "deepseek-v4-pro", "apiKey": "${DEEPSEEK_API_KEY}" }
   } }
   ```
   `~/.flowx/agents.json`
   ```json
   { "agents": {
     "claude-sonnet": { "executor": "claude", "model": "claude-sonnet-4" },
     "cursor-default": { "executor": "cursor", "model": "auto" },
     "recursive-deepseek": { "executor": "recursive", "provider": "deepseek", "maxSteps": 60 }
   } }
   ```
   再 `export DEEPSEEK_API_KEY=...`（缺变量会 fail-fast）。

4) **冒烟验证（不烧 API）**：先用 dry-run 跑通骨架再上真的。
   ```bash
   FLOWX_DRY_RUN=1 npx flowx orchestrate "随便写点东西" --repo .
   ```

## 2. 选对入口（决策树）

- 只想**一行需求自动跑**，单一目标 → `flowx orchestrate "<目标>" --repo . --agent <name>`
- 目标**大、可拆成多个独立子任务** → `flowx orchestrate "<大目标>" --split --concurrency 3`
- 流程**固定、要精细控制**（条件分支/重试/特定 HITL 点） → **手写 flow**（见 §3），`flowx run ./flows/x.js`
- 就是**标准开发流**（建分支→写码→审查→PR） → `flowx force-dev --feature <name> --repo .`
- 想**看所有 run 状态** → `flowx dashboard --repo . --open`

选 agent：BYO-LLM（`recursive`/`aider`/`claude`，可注入 provider/端点/密钥）vs 锁定型（`cursor`/`gemini`/`codex`，自管鉴权，**给 provider 会 fail-fast**）。

## 3. 手写 flow 的词汇表（只用这些原语）

一个 flow 是普通可执行 JS，`import` 只允许 `@force-lab/flowx`（+ `util`）。核心原语：

| 原语 | 用途 |
|------|------|
| `new Checkpoint(runId)` / `cp.step(key, fn)` / `cp.done()` | 断点续跑的步骤记录（key 唯一，已完成自动跳过） |
| `cp.pause(reason, ctx)` / `cp.has` / `cp.record` | HITL 暂停退出 / 并发安全回写 |
| `runAgent(prompt,{cli})` / `runAgentChain(prompt, chain)` | 驱动一个 CLI / 跨 CLI 限额回退 |
| `resolveAgent(name, agents, {providers})` | 按 agent profile 名解析执行器 |
| `runGate(gate)` / `runGates([...])` | 质量门：onFail rollback / resume-fix / autofix |
| `withSelfModGuard(fn,{repo})` / `captureBaseline` | 自改安全沙箱：失败硬回滚（verdict: committed/rolled-back/...） |
| `parallel(thunks,{concurrency})` / `pipeline` | 并发 / 流水线 |
| `runFlow(ref,opts)` / `fanOut(tasks,{concurrency,isolate})` | 子 flow 隔离子进程 / 并发编排+worktree 隔离+汇总 |
| `gitCommitAll` / `gitCreateBranch` / `gitWorktreeAdd` / `gitDiff` / `gitStatus` | 受控 git（**别裸调 child_process**） |
| `waitForInput` / `notify` / `setHitlBackend('terminal'\|'wecom')` | HITL |
| `isDryRun()` | dry-run 下跳过真实副作用 |

最小骨架：
```js
import { parseArgs } from 'util'
import { Checkpoint, setWorkdir, runAgent } from '@force-lab/flowx'
const { values: o } = parseArgs({ options: { 'run-id':{type:'string'}, repo:{type:'string',default:process.cwd()}, 'dry-run':{type:'boolean'} } })
if (o['dry-run']) process.env.FLOWX_DRY_RUN = '1'
setWorkdir(o.repo)
const cp = new Checkpoint(o['run-id'] ?? `run-${Date.now()}`)
const plan = await cp.step('plan', () => runAgent('做计划', { cli: 'claude' }))
await cp.step('impl', () => runAgent(`实现：${plan}`, { cli: 'claude' }))
cp.done()
```

禁止：import `fs`/`child_process`/`net`/`http`/`os`；裸调进程；在 `main()` 外写副作用。需要文件/git 走 flowx 原语。

## 4. 续跑 / 观测 / 调试

- **续跑**：用**同一个 `--run-id`** 再跑一次，已完成 step 打 `[skip]`。
- **产物**：`.flowx/runs/<run-id>/` 下 `state.json`（状态/完成步骤/暂停原因）、`run.log.jsonl`（每步耗时/输入输出/错误，逐行）、`report.md`（done 后摘要）。L3 还有 `flow.mjs`（续跑复用，不重生成）、`request.txt`、`--split` 的 `tasks.json` 与 `sub/<name>/flow.mjs`。
- **失败先看**：`run.log.jsonl` 末尾的 error 行 → 定位是哪个 step / gate；用 `--dry-run` + 同 run-id 复现骨架。

## 5. 排错对照（都是 fail-fast，按提示修）

| 报错/现象 | 含义 | 怎么修 |
|-----------|------|--------|
| `目标仓无法解析 @force-lab/flowx` | 目标仓没装本包 | `cd <repo> && npm install <flowx路径>`（见 §1.2） |
| `未知 provider 'x'` / `未知 agent 'x'` | `~/.flowx/*.json` 没这个名 | 补 providers/agents 配置或改用已定义的名字 |
| `执行器 'cursor' 不接受外部 provider` | 给锁定型执行器配了 provider | 从该 agent 去掉 `provider`，改用它自带 `model` |
| `环境变量 X 未设置（插值失败）` | `${X}` 没在 env 里 | `export X=...` 后重跑 |
| 生成的 flow 校验失败（import 白名单/语法/dry-run） | 生成代码违反契约 | 看 `.flowx/runs/<id>/` 产物；重试生成或换 agent；只用 §3 词汇表 |
| agent CLI 未装/未登录/限额 | L1 执行器不可用 | 装/登录对应 CLI；用 `runAgentChain` 配多 agent 回退 |
| `withSelfModGuard: 工作树不干净` | 自改前要求干净 baseline | 先 `git commit`/`stash`，或传 `requireClean:false` |

## 6. 边界（别误用）

flowx 是**进程定义/编排层**，不是运行时治理框架：它不存业务状态、无 daemon/常驻服务、**不做 DAG**（flow 用命令式代码表达）。运行时治理归上层系统。dry-run 只验证**结构/骨架/配置**（执行器与质量门被 fake），**不**验证真实 LLM 产出质量与真实构建——上线前务必跑一次真的。
