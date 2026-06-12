# 给 AI 使用

flowx 的使用者，很多时候本身就是一个 **AI agent**——它被丢给 flowx，要拿它来解决任务。flowx 自己的哲学就是"给生成 flow 的 AI 一份受控词汇表"；这一页把同样的思路用到**使用方 AI** 身上。

## 两种交付：skill + 单页速查

### flowx skill（随仓发布）

仓库里有 `skills/flowx/SKILL.md`——一个可被 Cursor / Claude 等装载的 skill。它自动触发、自带：

- **何时用 / 不用** 的判断
- **最小 bootstrap**（Node、安装、`~/.flowx` 最小配置、dry-run 冒烟）
- **入口决策树**（orchestrate / `--split` / 手写 flow / force-dev 怎么选）
- **能力词汇表**（手写 flow 只用这些原语）
- **排错对照表**（fail-fast 报错 → 修法）
- **边界**（不是运行时、不做 DAG、dry-run 验证什么）

把它放进你的 skills 目录即可让"使用 flowx 的 AI"开箱即用。

### `/llms.txt` 单页速查

[/llms.txt](/llms.txt) 是一份**可整页塞进 context** 的浓缩速查（能力清单 + 调用约定 + 禁止项 + 错误信号）。给 AI 喂这一页，它就能正确地用 flowx 干活，而不必读完整站。

## 入口决策树（文字版）

```
任务来了
├─ 一次性单步 / 纯读代码 / 无中断风险 → 不用 flowx
├─ 一行需求、单目标 → flowx orchestrate "<目标>" --repo . --agent <name>
├─ 大目标、可拆成多个独立子任务 → flowx orchestrate "<大目标>" --split --concurrency N
├─ 流程固定、要精细控制（条件分支/重试/特定 HITL 点）→ 手写 flow，flowx run ./flows/x.js
└─ 标准开发流（建分支→写码→审查→PR）→ flowx force-dev --feature <name> --repo .
```

选 agent：

```
要注入自己的端点/模型/密钥（BYO-LLM）？
├─ 是 → recursive / aider / claude（可配 provider）
└─ 否，用 CLI 自带鉴权 → cursor / gemini / codex（给 provider 会 fail-fast）
```

## 最小可复制流程

```bash
# 1. 目标仓能解析 flowx
cd <repo> && npm install @force-lab/flowx   # 或 npm install <flowx源码路径>

# 2. 最小配置（只用 cursor 等锁定型可跳过 providers）
mkdir -p ~/.flowx
# 写 ~/.flowx/agents.json: { "agents": { "cursor-default": {"executor":"cursor","model":"auto"} } }

# 3. dry-run 冒烟（不烧 API）
FLOWX_DRY_RUN=1 npx flowx orchestrate "测试目标" --repo . --agent cursor-default

# 4. 真跑
npx flowx orchestrate "真实目标" --repo . --agent cursor-default

# 5. 中断后续跑（同一个 run-id）
npx flowx orchestrate "..." --run-id <run-id>
```

完整步骤见 [从零到第一次跑通](/guide/from-zero)，撞错见 [排错 / FAQ](/guide/troubleshooting)。

## 给 AI 的硬约束（记牢这几条）

1. 手写 flow **只能** `import @force-lab/flowx`（+ `util`）；需要文件/git/进程 → 走 flowx 原语，**别裸调 `child_process`/`fs`**。
2. 每个 `cp.step` 的 `key` **唯一**；续跑用**同一个 `--run-id`**。
3. 锁定型执行器（cursor/gemini/codex）**别配 provider**。
4. 密钥用 `${ENV}`，**明文永不入仓**。
5. dry-run 只验证结构，**上线前跑一次真的**。
6. flowx 是编排层，**不替你管运行时**（不存业务状态、不做 DAG）。
