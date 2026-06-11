import { spawn } from 'child_process'

// ── 底层 CLI 调用 ─────────────────────────────────────────────────

function spawnCli(cli, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cli, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`[${cli}] timeout after ${timeout}ms`))
    }, timeout)

    proc.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`[${cli}] exit ${code}\n${stderr.trim()}`))
      else resolve(stdout)
    })
  })
}

// ── CLI 封装：各 Agent ────────────────────────────────────────────

/**
 * Claude Code CLI  (claude -p ...)
 * 输出格式：JSON 数组，取 type=result 条目的 result 字段
 */
export async function claude(prompt, { cwd = process.cwd(), model, timeout = 300_000, extraArgs = [] } = {}) {
  const args = ['-p', prompt, '--output-format', 'json']
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  const raw = await spawnCli('claude', args, cwd, timeout)
  try {
    const data = JSON.parse(raw)
    if (Array.isArray(data)) {
      const item = data.find(x => x.type === 'result')
      if (item?.is_error) throw new Error(`claude error: ${item.result}`)
      const usage = item?.usage ?? {}
      const result = item?.result ?? raw.trim()
      // 把 token 用量附在结果上，供审计层读取
      return Object.assign(String(result), {
        _meta: { cli: 'claude', model: item?.model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
      })
    }
    return data.result ?? raw.trim()
  } catch (e) {
    if (e.message.startsWith('claude error:')) throw e
    return raw.trim()
  }
}

/**
 * Gemini CLI  (gemini -p ...)
 * https://github.com/google-gemini/gemini-cli
 * 输出格式：纯文本
 */
export async function gemini(prompt, { cwd = process.cwd(), model, timeout = 300_000, extraArgs = [] } = {}) {
  const args = ['-p', prompt]
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  const raw = await spawnCli('gemini', args, cwd, timeout)
  return raw.trim()
}

/**
 * Codex CLI  (codex -p ...)
 * https://github.com/openai/codex
 * 输出格式：纯文本
 */
export async function codex(prompt, { cwd = process.cwd(), model, timeout = 300_000, extraArgs = [] } = {}) {
  const args = ['--approval-mode', 'full-auto', '-q', prompt]
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  const raw = await spawnCli('codex', args, cwd, timeout)
  return raw.trim()
}

/**
 * Aider  (aider --message ...)
 * https://aider.chat
 * 适合机械性批量修改，在已有 git repo 里直接 commit
 */
export async function aider(prompt, { cwd = process.cwd(), model, files = [], timeout = 600_000, extraArgs = [] } = {}) {
  const args = ['--message', prompt, '--yes-always', '--no-pretty']
  if (model) args.push('--model', model)
  args.push(...files, ...extraArgs)
  const raw = await spawnCli('aider', args, cwd, timeout)
  return raw.trim()
}

/**
 * Cursor Agent CLI  (agent -p ...)
 * 输出格式：单个 JSON 对象，result 字段是结果
 * 注意：首次在新目录运行需要 workspace trust 确认，建议在项目目录预先运行一次交互模式
 */
export async function cursor(prompt, { cwd = process.cwd(), timeout = 300_000, extraArgs = [] } = {}) {
  const args = ['-p', prompt, '--output-format', 'json', ...extraArgs]
  const raw = await spawnCli('agent', args, cwd, timeout)
  try {
    const data = JSON.parse(raw)
    if (data.is_error) throw new Error(`cursor agent error: ${data.result}`)
    const result = data.result ?? raw.trim()
    return Object.assign(String(result), {
      _meta: { cli: 'cursor', inputTokens: data.usage?.inputTokens, outputTokens: data.usage?.outputTokens }
    })
  } catch (e) {
    if (e.message.startsWith('cursor agent error:')) throw e
    return raw.trim()
  }
}

// ── 通用 runAgent：根据 cli 参数路由到对应封装 ────────────────────

const CLI_MAP = { claude, gemini, codex, aider, cursor }

let _defaultCwd = process.cwd()

/** 设置全局默认工作目录，flow 启动时调用一次，之后所有 runAgent 自动继承 */
export function setWorkdir(dir) {
  _defaultCwd = dir
}

export async function runAgent(prompt, { cli = 'claude', cwd, ...opts } = {}) {
  const fn = CLI_MAP[cli]
  if (!fn) throw new Error(`未知 CLI: ${cli}，支持：${Object.keys(CLI_MAP).join('/')}`)
  const result = await fn(prompt, { cwd: cwd ?? _defaultCwd, ...opts })
  // 把 _meta 暴露出来方便 checkpoint 记录，不影响 result 字符串本身
  return result
}

// ── 并发工具 ─────────────────────────────────────────────────────

/** 并行跑多个 agent，某个失败返回 null 不中断整体 */
export async function parallel(thunks) {
  return Promise.all(thunks.map(fn =>
    fn().catch(err => {
      console.error(`  [parallel error] ${err.message}`)
      return null
    })
  ))
}

/** 把 items 依次流经多个 stage，每个 stage 是 async (item) => result */
export async function pipeline(items, ...stages) {
  let current = items
  for (const stage of stages) {
    current = await Promise.all(current.map((item, i) => stage(item, i)))
  }
  return current
}

// ── HITL ─────────────────────────────────────────────────────────

/** 等待终端输入，无 MCP 时的 fallback */
export async function waitForInput(prompt) {
  const { createInterface } = await import('readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(`\n${prompt}\n> `, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}
