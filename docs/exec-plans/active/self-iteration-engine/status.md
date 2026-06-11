# status.md — flowx 自我迭代引擎 Step 1（AI 恢复入口）

> AI 恢复上下文先读本文件，再读 implement.md / plan.md / prompt.md。

**最后更新**：2026-06-11
**分支**：`feat/self-iteration-engine`（flowx 仓，尚未提交本次成果）
**整体状态**：🟢 Step 1 全部里程碑完成，等待 kongjie 拍板后续

## 进度

| 里程碑 | 状态 |
|--------|------|
| M1 recursive adapter（agent.js）+ 单测 | ✅ |
| M2 withSelfModGuard（self-mod-guard.js）+ 单测 | ✅ |
| M3 qualityGate runner（quality-gate.js）+ 单测 | ✅ |
| M4 可插拔 HITL backend（terminal/wecom）+ 单测 | ✅ |
| M5 failure-context（failure-context.js）+ 单测 | ✅ |
| M6 flows/recursive-self-improve.js 编排 | ✅ |
| M7 真实 parity（deepseek，count_lines）E2E | ✅ |

- 单测：28 个全绿（含 2 个结构化 E2E：committed + rolled-back 双路径，不烧 API）。
- 真实 parity：verdict 矩阵全验（committed×1 + rolled-back×2），回滚干净、审计产物齐全、commit 形态对齐 self-improve.sh。

## 新增文件（flowx 仓）

- `self-mod-guard.js` / `quality-gate.js` / `failure-context.js`
- `flows/recursive-self-improve.js`
- `test/{agent,self-mod-guard,quality-gate,failure-context,flow-e2e}.test.js`
- `agent.js`（新增 recursive adapter + 可插拔 HITL）、`index.js`（导出）、`package.json`（test 脚本 + files）

## 待 kongjie 拍板（已企微问询，超时未回）

- **A) count_lines 分支处置**：`self-improve/count-lines-deepseek-20260611T145956`（recursive 仓，commit cf0b9b2）→ 保留待 review / 合 main / 丢弃清理 worktree？（默认：保留不动）
- **B) review 健壮化**（限步数 + 强制结构化 verdict 提取）现在做还是后续？
- **C) 是否把 Step 1 成果提交到 flowx `feat/self-iteration-engine` 分支？**（默认：等指令，暂不提交）

## 已知下一步（不阻塞）

1. review 健壮化：给 self-review 加 max-steps 限制 + 「resume 追问 only-VERDICT」强制结构化提取。
2. （B 阶段）协议规范化 + revengers 选择性接入（L3 动态编排）——属 Step 2/3，本步非目标。

## 现场（未做任何破坏性操作）

- recursive 仓 main 未动；count_lines 改动仅在隔离 worktree 的特性分支上。
- flowx 仓改动均在工作区，未 commit。
