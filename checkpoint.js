import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'

// 从 agent 结果里提取 _meta（cli/model/token），只挑可观测字段，缺省安全返回 {}。
function pickAgentMeta(result) {
  const m = result && result._meta
  if (!m || typeof m !== 'object') return {}
  const out = {}
  if (m.cli != null) out.cli = m.cli
  if (m.model != null) out.model = m.model
  if (Number.isFinite(m.inputTokens)) out.inputTokens = m.inputTokens
  if (Number.isFinite(m.outputTokens)) out.outputTokens = m.outputTokens
  return out
}

export class Checkpoint {
  constructor(runId, stateDir = '.flowx/runs') {
    this.runId = runId
    this.dir = join(stateDir, runId)
    this.path = join(this.dir, 'state.json')
    this.logPath = join(this.dir, 'run.log.jsonl')  // 每行一条结构化日志
    this._inFlight = new Set()  // 重入保护：防止并发 step() 对同一 key 双重执行
    mkdirSync(this.dir, { recursive: true })
    this.state = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : { runId, status: 'running', completed: {}, steps: [], startedAt: new Date().toISOString() }
    this._flush()
  }

  // 核心：有缓存就跳过，没有就执行并存档
  async step(key, fn, { meta = {} } = {}) {
    if (this.state.completed[key] !== undefined) {
      console.log(`  [skip] ${key}`)
      return this.state.completed[key]
    }
    if (this._inFlight.has(key)) {
      throw new Error(`Checkpoint.step: key "${key}" is already in-flight (concurrent call detected)`)
    }
    this._inFlight.add(key)
    console.log(`  [run]  ${key}`)
    this.state.currentStep = key
    this._flush()

    const startedAt = Date.now()
    let result, error

    try {
      result = await fn()
    } catch (e) {
      error = e.message
      this._inFlight.delete(key)
      this._log({ key, status: 'error', error, durationMs: Date.now() - startedAt, meta })
      // 控制台打出完整 error，方便不翻 jsonl 就能诊断（e.message 里已包含 stderr）
      console.error(`  [error] ${key}: ${error}`)
      throw e
    }

    const durationMs = Date.now() - startedAt
    this._inFlight.delete(key)
    this.state.completed[key] = result
    this.state.currentStep = null

    // 自动捕获 agent 结果上挂的 _meta（cli/model/inputTokens/outputTokens）——
    // adapter 用 Object.assign(String(result), {_meta}) 挂在 String 包装对象上，
    // 存进 completed 时会序列化成纯字符串而丢失，这里显式提进步骤元数据，供看板汇总 token/模型。
    const autoMeta = pickAgentMeta(result)
    // 记录到 steps 列表（摘要用）和 jsonl 日志（完整审计用）；显式 meta 优先级最高。
    const stepRecord = { key, status: 'done', durationMs, completedAt: new Date().toISOString(), ...autoMeta, ...meta }
    this.state.steps.push(stepRecord)
    this._log({ key, status: 'done', durationMs, result, meta: { ...autoMeta, ...meta } })
    this._flush()
    return result
  }

  // HITL：暂停并干净退出，下次从这里继续
  pause(reason, context = {}) {
    console.log(`\n[paused] ${reason}`)
    this.state.status = 'paused'
    this.state.pauseReason = reason
    this.state.pauseContext = context
    this._log({ key: '__pause__', status: 'paused', reason })
    this._flush()
    process.exit(0)
  }

  // 标记整个 workflow 完成，生成可读报告
  done(summary = {}) {
    this.state.status = 'completed'
    this.state.completedAt = new Date().toISOString()
    this.state.summary = summary
    this._flush()
    this._writeReport()
  }

  // 是否已记录过某个 key（fan-out 时用来跳过已完成的子任务）
  has(key) { return this.state.completed[key] !== undefined }

  // 并发安全地记录一个已算好的结果（非 fn）。整段同步执行、无 await，
  // 单线程下并发回调也不会交错，适合 parallel/fanOut 里各子任务回写完成状态。
  record(key, result, meta = {}) {
    this.state.completed[key] = result
    this.state.steps.push({ key, status: 'done', completedAt: new Date().toISOString(), ...meta })
    this._flush()
    return result
  }

  // 记录一条「非步骤」的结构化事件（provider fallback / 质量门结果 / 自定义信号），
  // 只追加进 run.log.jsonl（形如 {ts, event:'fallback'|'gate'|…, ...data}），不进 state.json
  // —— 避免 state 膨胀，同时让看板能从日志里把可观测信号「数据自描述」地读出来。
  // 观测用途，绝不应影响主流程，故吞掉任何写盘异常。
  event(type, data = {}) {
    try { this._log({ event: type, ...data }) } catch { /* 观测失败不影响主流程 */ }
  }

  getPauseContext() { return this.state.pauseContext || {} }
  get status() { return this.state.status }

  // ── 内部工具 ────────────────────────────────────────────────────

  _log(entry) {
    appendFileSync(this.logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  }

  _flush() {
    writeFileSync(this.path, JSON.stringify(this.state, null, 2))
  }

  // 生成人可读的 Markdown 报告
  _writeReport() {
    const s = this.state
    const totalMs = new Date(s.completedAt) - new Date(s.startedAt)
    const totalSec = (totalMs / 1000).toFixed(1)

    const stepRows = s.steps.map(st => {
      // cp.record（fanOut 各组回写）不带 durationMs，旧版会渲染成 "NaNs"；此处守卫为 "-"。
      const sec = Number.isFinite(st.durationMs) ? `${(st.durationMs / 1000).toFixed(1)}s` : '-'
      const cli = st.cli ?? '-'
      return `| ${st.key} | ${st.status} | ${sec} | ${cli} |`
    }).join('\n')

    const report = `# Workflow Run Report

**Run ID**: ${s.runId}
**Status**: ${s.status}
**Started**: ${s.startedAt}
**Completed**: ${s.completedAt}
**Total time**: ${totalSec}s

## Summary
${Object.entries(s.summary).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}

## Steps

| Step | Status | Duration | CLI |
|------|--------|----------|-----|
${stepRows}

## Full log
See \`run.log.jsonl\` for complete inputs/outputs per step.
`
    writeFileSync(join(this.dir, 'report.md'), report)
    console.log(`\n📋 报告已生成：${join(this.dir, 'report.md')}`)
  }
}
