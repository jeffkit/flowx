# flowx 效果评估方案

> 评估核心问题：**和原来 skill 版 force-dev 相比，JS workflow 版本是否更可靠、更高效、产出质量更好？**

---

## 一、评估维度与指标

### 1. 流程可靠性（优先级：最高）

这是 workflow 化的核心动机。

| 指标 | 定义 | 目标值 |
|---|---|---|
| 断点恢复成功率 | 中断后续跑，从正确位置继续的次数 / 总续跑次数 | ≥ 95% |
| 步骤跳过准确率 | 续跑时已完成步骤零重复执行的次数 / 总续跑次数 | 100% |
| HITL 节点响应正确率 | 用户输入后流程走向符合预期的次数 / 总 HITL 节点触发次数 | ≥ 95% |
| 非预期中断率 | 未到达 HITL 节点或正常结束而崩溃的次数 / 总运行次数 | ≤ 5% |

**数据来源**：`state.json`（status 字段）、手动观察记录

---

### 2. 执行效率

| 指标 | 定义 | 数据来源 |
|---|---|---|
| 端到端总耗时 | 从 workflow 启动到 PR 创建的总时间 | `report.md` Total time |
| Phase 耗时分布 | 各 phase（p1/p2/p3/p4）耗时占比 | `run.log.jsonl` durationMs |
| Token 消耗 | 每次 workflow 的总 input/output tokens | `run.log.jsonl` inputTokens/outputTokens |
| 审查轮次分布 | 每个里程碑触发 fix-1/fix-2/fix-3 的频率分布 | `run.log.jsonl` step key |

**参考基线**：skill 版 force-dev 人工计时（对话轮数 × 平均响应时间估算）

---

### 3. 产出质量

| 指标 | 定义 | 数据来源 |
|---|---|---|
| PR 直接合并率 | PR 创建后无需修改直接合并 / 总 PR 数 | GitHub PR 记录 |
| PR 修改后合并率 | 需要人工修改后才合并 / 总 PR 数 | GitHub PR 记录 |
| 人工 review 问题密度 | PR 被合并前人工 reviewer 留下的 comment 数 / 变更行数 | GitHub PR comments |
| E2E 首次通过率 | 里程碑 E2E 第一次运行即 PASS / 总 E2E checkpoint 次数 | `run.log.jsonl` |
| Adversarial review NEEDS_FIX 率 | 审查触发修复的里程碑数 / 总里程碑数（正常范围：30%~70%） | `run.log.jsonl` step key |

> NEEDS_FIX 率说明：
> - < 30%：审查可能不够严格
> - 30%~70%：正常，说明审查在发现真实问题
> - > 70%：实现质量可能有问题，或审查标准过严

---

### 4. 使用体验

| 指标 | 定义 | 收集方式 |
|---|---|---|
| 首次上手时间 | 新开发者从安装到跑完第一个 flow 的时间 | 用户自报 |
| HITL 中断率 | 用户在 HITL 节点选择不继续的次数 / 总 HITL 触发次数（高则说明前期澄清不足）| `state.json` pauseReason |
| skill 调用频率 | `/feature-dev` 实际调用次数（与以前 `/force-dev` 对比）| Claude Code 使用记录 |

---

## 二、数据收集方法

### 自动采集（已内置）

每次 workflow 运行后，`.flowx/runs/{run-id}/` 下有三个文件：

```
state.json       → status、步骤完成情况、暂停原因
run.log.jsonl    → 每步耗时、CLI、输入输出、错误
report.md        → 可读摘要，包含总耗时和步骤表
```

### 批量分析脚本

跑完若干次后，用以下命令快速出数据：

```bash
# 所有 run 的总耗时列表
cat .flowx/runs/*/run.log.jsonl \
  | jq -s '[.[] | select(.key == "__done__")] | .[] | {runId: .runId, totalMs: .durationMs}'

# 审查轮次分布
cat .flowx/runs/*/run.log.jsonl \
  | jq -r '.key' \
  | grep 'fix-' \
  | sed 's/.*fix-//' \
  | sort | uniq -c

# E2E 首次通过率
cat .flowx/runs/*/run.log.jsonl \
  | jq 'select(.key | test("\\.e2e$")) | .result' \
  | grep -c 'E2E:PASS'
```

### 人工记录

每次真实案例跑完后，在下方 **§ 三、运行记录** 里追加一行。

---

## 三、运行记录

> 每次真实案例跑完后在此追加，积累 5~10 次后开始看趋势。

| 日期 | run-id | feature | 总耗时 | 审查轮次 | E2E | PR 结果 | 备注 |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | 待首次运行 |

---

## 四、评估节点

| 节点 | 触发条件 | 产出 |
|---|---|---|
| **初步验证** | 完成前 3 次真实案例 | 确认流程跑通，记录主要 bug |
| **效果评估** | 累计 10 次运行 | 对比 skill 版，决定是否全面推广 |
| **优化迭代** | 发现某指标持续不达标 | 针对性改进 flow 或框架 |

---

## 五、与 skill 版 force-dev 的对比基线

skill 版的历史数据较难精确获取，以下为估算基线，供参考：

| 指标 | skill 版（估算） | workflow 版（目标） |
|---|---|---|
| 断点恢复成功率 | ~60%（依赖 status.md 人工恢复） | ≥ 95% |
| 端到端耗时 | 未记录 | 首次建立基线 |
| 非预期中断率 | ~20%（context 被撑爆） | ≤ 5% |
| 人工操作节点数 | 每个里程碑 2~3 次确认 | 仅 1 次（prompt.md 确认） |
