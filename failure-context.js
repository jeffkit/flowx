import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'

// ── failure-context：最小 learnings（写入 on-fail + 注入 on-retry）─────
//
// recursive/revengers 都有「把失败教训喂回下一次尝试」的机制。这里只做最小形态：
// 失败时写一份结构化 failure-context.md，下次重试时读取并注入 system prompt，
// 读取后即删除（只注入一次，避免污染后续无关尝试）。完整 RAG 召回留后续。

function ctxPath(dir, tag) {
  return join(dir, `${tag}-failure-context.md`)
}

/**
 * 写入失败上下文。
 * @returns {string} 写入的文件路径
 */
export function writeFailureContext(dir, tag, { reason, tailLog = '', provider, model } = {}) {
  mkdirSync(dir, { recursive: true })
  const body = [
    '## Previous Attempt Failed', '',
    `- Reason: ${reason ?? 'unknown'}`,
    provider ? `- Provider: ${provider}` : null,
    model ? `- Model: ${model}` : null,
    `- Timestamp: ${new Date().toISOString()}`, '',
    '### Last lines of agent output:', '```text', tailLog.replace(/```/g, "'''"), '```', '',
    '### Guidance for retry:',
    '- Do NOT repeat the approach that caused this failure.',
    '- If it was a compile/test error, fix it before proceeding.',
    '- If output was truncated, use smaller patches instead of full-file rewrites.',
  ].filter((l) => l !== null).join('\n')
  const p = ctxPath(dir, tag)
  writeFileSync(p, body + '\n')
  return p
}

/**
 * 原子消费失败上下文（只注入一次）。
 * 用 rename 先抢占文件，再读取，避免并发双消费的 TOCTOU。
 * @returns {string|null} 上下文内容，无则 null
 */
export function readAndConsumeFailureContext(dir, tag) {
  const p = ctxPath(dir, tag)
  const tmp = `${p}.consuming.${process.pid}`
  try {
    renameSync(p, tmp)  // 原子：成功则本进程独占；ENOENT 则文件不存在或已被消费
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  try {
    return readFileSync(tmp, 'utf8')
  } finally {
    rmSync(tmp, { force: true })
  }
}
