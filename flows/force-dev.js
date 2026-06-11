#!/usr/bin/env node
/**
 * force-dev flow — FORCE Lab 标准开发工作流
 *
 * 用法：
 *   node flows/force-dev.js --run-id <id> --feature <name> [--repo <path>]
 *   node flows/force-dev.js --run-id <id>          # 断点续跑，不需要重传参数
 *   node flows/force-dev.js --list                 # 列出所有 run
 *
 * Phase 1B（需求澄清）在脚本外完成，用户确认后传入 --feature 启动脚本。
 */

import { parseArgs } from 'util'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { Checkpoint } from '../checkpoint.js'
import { runAgent, parallel, waitForInput, setWorkdir } from '../agent.js'

// ── CLI 参数解析 ─────────────────────────────────────────────────
const { values: opts } = parseArgs({
  options: {
    'run-id':  { type: 'string' },
    feature:   { type: 'string' },
    repo:      { type: 'string', default: process.cwd() },
    list:      { type: 'boolean', default: false },
    model:     { type: 'string' },               // 可选，不传则用各 CLI 自身默认模型
    reviewer:  { type: 'string', default: 'claude' },  // 审查用哪个 CLI
  }
})

if (opts.list) {
  listRuns()
  process.exit(0)
}

const runId = opts['run-id'] ?? `run-${Date.now()}`
const repo  = opts.repo

// ── 主流程 ───────────────────────────────────────────────────────
const cp = new Checkpoint(runId)
// model 不传则各 CLI 用自身默认值
const agentOpts = opts.model ? { model: opts.model } : {}

// 续跑时从 state 里恢复参数，首次运行时从 CLI 取
const feature = opts.feature ?? cp.getPauseContext().feature
if (!feature) {
  console.error('缺少 --feature 参数')
  process.exit(1)
}

// 全局绑定工作目录，后续所有 runAgent 调用自动继承
setWorkdir(repo)

console.log(`\n▶ force-dev  run=${runId}  feature=${feature}  repo=${repo}  status=${cp.status}\n`)

await run()

// ── Phase 实现 ───────────────────────────────────────────────────

async function run() {
  // ── Phase 1C: 建分支 ──────────────────────────────────────────
  const branch = await cp.step('p1.create-branch', () =>
    runAgent(
      `在 ${repo} 创建特性分支 feat/${feature}，切换到该分支，只返回分支名，不要其他内容。`,
      agentOpts
    )
  )
  console.log(`  branch: ${branch?.trim()}`)

  // ── Phase 1D: 写 prompt.md ────────────────────────────────────
  await cp.step('p1.write-prompt', () =>
    runAgent(
      `在 ${repo}/docs/exec-plans/active/${feature}/ 目录创建 prompt.md。
       内容包含三个部分：目标（用户视角描述）、完成标准（每条可验证）、非目标（至少一条）。
       feature: ${feature}
       写完文件后只回复 "done"。`,
      agentOpts
    )
  )

  // ── HITL Gate: 用户确认 prompt.md ────────────────────────────
  const promptApproved = await cp.step('p1.prompt-approval', async () => {
    const answer = await waitForInput(
      `prompt.md 已生成，请查看 docs/exec-plans/active/${feature}/prompt.md\n确认继续？(y/n)`
    )
    return answer === 'y'
  })

  if (!promptApproved) {
    cp.pause('用户未确认 prompt.md', { feature, branch })
  }

  // ── Phase 2: 写 plan.md，再单独读取里程碑结构 ─────────────────
  await cp.step('p2.write-plan', () =>
    runAgent(
      `读取 ${repo}/docs/exec-plans/active/${feature}/prompt.md，
       在同目录创建 plan.md，包含：里程碑列表（每个有验证命令）、E2E checkpoint 标记。
       写完后只回复 "done"。`,
      agentOpts
    )
  )

  // 单独一步提取里程碑结构，要求严格 JSON 输出
  const milestonesJson = await cp.step('p2.parse-milestones', () =>
    runAgent(
      `读取 ${repo}/docs/exec-plans/active/${feature}/plan.md，
       提取所有里程碑，只返回如下 JSON，不要有任何其他文字：
       {"milestones":[{"id":"m1","name":"里程碑名称","e2e":false}]}
       e2e 字段：该里程碑有 E2E checkpoint 标记则为 true，否则为 false。`,
      agentOpts
    )
  )

  let milestones
  try {
    // 从返回文本里提取 JSON（防止 claude 在前后多输出文字）
    const match = milestonesJson?.match(/\{[\s\S]*\}/)
    milestones = match ? JSON.parse(match[0]).milestones : null
    if (!Array.isArray(milestones) || milestones.length === 0) throw new Error('empty')
  } catch {
    milestones = [{ id: 'm1', name: 'main', e2e: false }]
  }
  console.log(`  milestones: ${milestones.map(m => m.id).join(', ')}`)

  // ── Phase 3: 里程碑循环 ───────────────────────────────────────
  for (const m of milestones) {
    await executeMilestone(m, feature, repo, branch)
  }

  // ── Phase 4: 归档 + PR ────────────────────────────────────────
  await cp.step('p4.archive', () =>
    runAgent(
      `执行以下步骤，工作目录 ${repo}：
       1. git mv docs/exec-plans/active/${feature} docs/exec-plans/completed/${feature}
       2. git commit -m "docs: archive exec-plan for ${feature}"
       3. git push -u origin ${branch}
       完成后只回复 "done"。`,
      agentOpts
    )
  )

  await cp.step('p4.pr', () =>
    runAgent(
      `在 ${repo} 用 gh pr create 创建 PR：
       title: feat: ${feature}
       body: 描述 what/why/how-to-test
       完成后只返回 PR URL。`,
      agentOpts
    )
  )

  await cp.step('p4.journal', () =>
    runAgent(
      `在 ${repo}/journal/ 目录（不存在则创建）写今天的 journal 条目，
       记录 feature=${feature} 的完成情况，格式参考目录内已有文件。
       完成后只回复 "done"。`,
      agentOpts
    )
  )

  cp.done({ feature, branch })
  console.log(`\n✓ force-dev 完成  feature=${feature}`)
}

async function executeMilestone(m, feature, repo, branch) {
  const base = `p3.${m.id}`
  const planDir = `${repo}/docs/exec-plans/active/${feature}`

  // 实现
  await cp.step(`${base}.implement`, () =>
    runAgent(
      `读取 ${planDir}/plan.md，执行里程碑 ${m.id}（${m.name}）：
       写代码、写测试、运行 lint+typecheck+test+build、
       在 ${planDir}/reviews/${m.id}/ 目录（不存在则创建）写 review-request.yaml、
       更新 ${planDir}/implement.md、git commit。
       完成后最后一行只输出 IMPL:DONE。`,
      agentOpts
    )
  )

  // 审查（reviewer 可以是不同的 CLI，例如 gemini）
  const reviewVerdict = await cp.step(`${base}.review`, () =>
    runAgent(
      `读取 ${planDir}/reviews/${m.id}/review-request.yaml 和相关代码，
       执行对抗性审查，把结果写入 ${planDir}/reviews/${m.id}/review-findings.yaml。
       最后一行只输出 VERDICT:PASS 或 VERDICT:NEEDS_FIX，不要其他内容。`,
      { cli: opts.reviewer, model: opts.model }
    )
  )

  // 修复循环（最多 3 轮）
  if (reviewVerdict?.includes('NEEDS_FIX')) {
    await fixLoop(m, base, planDir, repo)
  }

  // E2E（如果标记了 checkpoint）
  if (m.e2e) {
    await cp.step(`${base}.e2e`, () =>
      runAgent(
        `在 ${repo} 跑 E2E 验证里程碑 ${m.id}：
         argusai status → argusai dev/rebuild → argusai run。
         最后一行只输出 E2E:PASS 或 E2E:FAIL:原因。`,
        agentOpts
      )
    )
  }
}

async function fixLoop(m, base, planDir, repo) {
  for (let i = 1; i <= 3; i++) {
    const fixKey = `${base}.fix-${i}`
    if (cp.state.completed[fixKey] === 'PASS') break

    await cp.step(fixKey, () =>
      runAgent(
        `读取 ${planDir}/reviews/${m.id}/review-findings.yaml，
         修复所有 CRITICAL 和 HIGH 问题，补充对抗性测试，
         重跑 lint+test+build，更新 review-findings.yaml，git commit。
         最后一行只输出 VERDICT:PASS 或 VERDICT:NEEDS_FIX，不要其他内容。`,
        agentOpts
      )
    )

    const verdict = cp.state.completed[fixKey]
    if (verdict?.includes('PASS')) break
    if (i === 3) {
      console.warn(`\n⚠ ${m.id} 超过 3 轮未通过审查，需要人工介入`)
      cp.pause(`${m.id} review escalated`, { milestone: m.id })
    }
  }
}

// ── 列出所有 run ─────────────────────────────────────────────────
function listRuns() {
  const dir = '.flowx/runs'
  if (!existsSync(dir)) { console.log('无历史 run'); return }
  readdirSync(dir).forEach(id => {
    const s = JSON.parse(readFileSync(`${dir}/${id}/state.json`, 'utf8'))
    console.log(`${id}  status=${s.status}  feature=${s.pauseContext?.feature ?? '?'}  step=${s.currentStep ?? s.status}`)
  })
}
