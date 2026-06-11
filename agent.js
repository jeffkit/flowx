import { spawn } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

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

// ── recursive 执行器 adapter ──────────────────────────────────────
//
// recursive（github.com/jeffkit/recursive）是一个极简的 Rust coding agent
// kernel，自身能在 worktree 里改自己的源码。在 flowx 里它只是一个「执行器」：
// 把它当子进程 spawn，run/replay 一个 goal。
//
// 与 claude/cursor adapter 的关键区别：
//   recursive 的 **exit code 是数据，不是错误**（0=正常结束、1=失败、
//   101=panic、128+N=信号、BudgetExceeded 也以非零退出）。因此这里用
//   spawnCapture 不抛错，把 exit code / finishReason / budgetExceeded /
//   transcript 长度全部放进 _meta，交给上层 flow 决策。

/**
 * 捕获式 spawn：不因非零退出码 reject。合并 stdout+stderr（对齐 self-improve.sh 的 2>&1）。
 * 返回 { stdout, exitCode, timedOut, spawnError? }。
 */
export function spawnCapture(cmd, args, { cwd = process.cwd(), timeout, env, onData } = {}) {
  return new Promise(resolve => {
    let proc
    try {
      proc = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ stdout: `[spawn error] ${err.message}`, exitCode: -1, timedOut: false, spawnError: err.message })
      return
    }
    let out = ''
    let timedOut = false
    const append = d => { const s = d.toString(); out += s; onData?.(s) }
    proc.stdout.on('data', append)
    proc.stderr.on('data', append)
    const timer = timeout ? setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeout) : null
    proc.on('error', err => {
      if (timer) clearTimeout(timer)
      resolve({ stdout: out + `\n[spawn error] ${err.message}`, exitCode: -1, timedOut, spawnError: err.message })
    })
    proc.on('close', code => {
      if (timer) clearTimeout(timer)
      resolve({ stdout: out, exitCode: code ?? -1, timedOut })
    })
  })
}

/** 解析 recursive 二进制路径：优先 release，其次 debug，最后回退 PATH 上的 recursive。 */
export function resolveRecursiveBin(cwd = process.cwd()) {
  for (const p of ['target/release/recursive', 'target/debug/recursive']) {
    if (existsSync(join(cwd, p))) return join(cwd, p)
  }
  return 'recursive'
}

/**
 * recursive 执行器。
 *
 * @param {string} goal 目标文本（run 模式）或续跑时追加的提示（replay 模式）
 * @param {object} opts
 *   - cwd              工作目录（也是 --workspace 的解析基准）
 *   - bin              recursive 二进制路径（默认自动解析 cwd 下的 target/）
 *   - workspace        --workspace 值（默认 '.'）
 *   - systemPromptFile --system-prompt-file
 *   - transcriptOut    --transcript-out（用于 resume / 统计 transcript 长度）
 *   - pricingFile      --pricing-file
 *   - log              --log 级别（默认 'warn'）
 *   - allowTools       --allow-tools（如 'Read,Glob'，给只读审查用）
 *   - replayFrom       { transcript, resumeFrom } → 走 replay 子命令
 *   - env              额外环境变量（合并进 process.env，flow 用它设 provider/model/budget）
 *   - timeout          硬超时 ms（默认 30min，对齐 recursive HARD_TIMEOUT）
 *   - onData           流式输出回调（用于 watchdog / tee 日志）
 * @returns {Promise<String & {_meta}>} stdout 字符串，附 _meta
 */
export async function recursive(goal, {
  cwd = process.cwd(),
  bin,
  workspace = '.',
  systemPromptFile,
  transcriptOut,
  pricingFile,
  provider,
  model,
  apiKey,
  apiBase,
  maxSteps,
  log = 'warn',
  allowTools,
  replayFrom,
  env,
  timeout = 1_800_000,
  onData,
} = {}) {
  const resolvedBin = bin ?? resolveRecursiveBin(cwd)
  const args = ['--workspace', workspace]
  if (systemPromptFile) args.push('--system-prompt-file', systemPromptFile)
  if (transcriptOut) args.push('--transcript-out', transcriptOut)
  if (pricingFile) args.push('--pricing-file', pricingFile)
  if (provider) args.push('--provider', provider)   // openai | anthropic（协议类型）
  if (model) args.push('--model', model)
  if (apiKey) args.push('--api-key', apiKey)
  if (apiBase) args.push('--api-base', apiBase)
  if (maxSteps) args.push('--max-steps', String(maxSteps))
  if (log) args.push('--log', log)
  if (allowTools) args.push('--allow-tools', allowTools)
  if (replayFrom) {
    args.push('replay', replayFrom.transcript, '--resume-from', String(replayFrom.resumeFrom), goal)
  } else {
    args.push('run', goal)
  }

  const { stdout, exitCode, timedOut, spawnError } = await spawnCapture(resolvedBin, args, { cwd, timeout, env, onData })

  const budgetExceeded = /reason:\s*BudgetExceeded/.test(stdout)
  const finishMatch = stdout.match(/\[done after \d+ steps\]\s*reason:\s*(.+)/)
  const finishReason = finishMatch ? finishMatch[1].trim() : null

  // panic 判定：Rust panic 默认 exit 101，信号 128+N。
  const panicked = exitCode === 101 || (typeof exitCode === 'number' && exitCode >= 128)

  let transcriptMessages = 0
  if (transcriptOut && existsSync(transcriptOut)) {
    try {
      transcriptMessages = JSON.parse(readFileSync(transcriptOut, 'utf8')).messages?.length ?? 0
    } catch { /* transcript 可能未写完 / 非 JSON，忽略 */ }
  }

  return Object.assign(String(stdout), {
    _meta: { cli: 'recursive', exitCode, timedOut, spawnError, budgetExceeded, finishReason, panicked, transcriptMessages },
  })
}

// ── 通用 runAgent：根据 cli 参数路由到对应封装 ────────────────────

const CLI_MAP = { claude, gemini, codex, aider, cursor, recursive }

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

// ── HITL（可插拔后端：terminal / wecom / 自定义）──────────────────
//
// 一个 HITL backend 是 { waitForInput(prompt) → Promise<string>,
// notify(message) → Promise<void> }。flow 启动时用 setHitlBackend 选定：
//   setHitlBackend('terminal')                 // 默认，readline
//   setHitlBackend('wecom', { ...config })      // 企微（mcp2cli 或注入 sender）
//   setHitlBackend(customBackendObject)         // 直接注入（测试/宿主集成）

/** 终端后端：readline 阻塞等待输入。 */
const terminalBackend = {
  async waitForInput(prompt) {
    const { createInterface } = await import('readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return new Promise(resolve => {
      rl.question(`\n${prompt}\n> `, answer => {
        rl.close()
        resolve(answer.trim())
      })
    })
  },
  async notify(message) {
    console.log(`\n[notify] ${message}\n`)
  },
}

/**
 * 企微后端。两种接法（优先级从高到低）：
 *   1. 注入函数：config.sendAndWait(message, ctx) / config.send(message, ctx)
 *      —— 最易测试、宿主可直接对接 wecom-hil MCP。
 *   2. mcp2cli：shell 调用 wecom-hil MCP 的 send_and_wait_reply / send_message_only。
 * ctx = { projectName, chatId }。
 */
function makeWecomBackend(config = {}) {
  const projectName = config.projectName ?? 'flowx'
  const chatId = config.chatId ?? null
  const ctx = { projectName, chatId }

  if (typeof config.sendAndWait === 'function' || typeof config.send === 'function') {
    return {
      async waitForInput(prompt) {
        if (typeof config.sendAndWait !== 'function') {
          throw new Error('wecom backend: sendAndWait 未配置，无法等待回复')
        }
        return await config.sendAndWait(prompt, ctx)
      },
      async notify(message) {
        if (typeof config.send === 'function') return void await config.send(message, ctx)
        if (typeof config.sendAndWait === 'function') return // 仅有 sendAndWait 时，notify 退化为 best-effort 跳过
      },
    }
  }

  // mcp2cli 真实实现：调用 wecom-hil MCP 工具。
  const mcp2cli = config.mcp2cli ?? 'mcp2cli'
  const server = config.server ?? '@wecom-hil'
  const callTool = async (tool, message, { wait }) => {
    const payload = JSON.stringify({ message, project_name: projectName, ...(chatId ? { chat_id: chatId } : {}) })
    const { stdout, exitCode } = await spawnCapture(mcp2cli, [server, tool, '--json', payload], { timeout: wait ? 86_400_000 : 60_000 })
    if (exitCode !== 0) throw new Error(`wecom mcp2cli ${tool} exit ${exitCode}: ${stdout.slice(0, 200)}`)
    return stdout
  }
  return {
    async waitForInput(prompt) {
      const out = await callTool('send_and_wait_reply', prompt, { wait: true })
      try {
        const data = JSON.parse(out)
        return data?.replies?.[0]?.content ?? out.trim()
      } catch { return out.trim() }
    },
    async notify(message) {
      await callTool('send_message_only', message, { wait: false }).catch(err => {
        console.warn(`[wecom notify] 失败（忽略）：${err.message}`)
      })
    },
  }
}

let _hitlBackend = terminalBackend

/** 选定 HITL 后端：'terminal' | 'wecom' | 自定义 backend 对象。 */
export function setHitlBackend(backend, config = {}) {
  if (backend && typeof backend === 'object') { _hitlBackend = backend; return }
  if (backend === 'terminal') { _hitlBackend = terminalBackend; return }
  if (backend === 'wecom') { _hitlBackend = makeWecomBackend(config); return }
  throw new Error(`未知 HITL 后端: ${backend}（支持 terminal/wecom/自定义对象）`)
}

/** 当前 HITL 后端（测试 / 调试用）。 */
export function getHitlBackend() { return _hitlBackend }

/** 阻塞等待人类输入（路由到当前后端）。 */
export async function waitForInput(prompt) {
  return _hitlBackend.waitForInput(prompt)
}

/** 单向通知人类，不等待（路由到当前后端；后端无 notify 时回退终端打印）。 */
export async function notify(message) {
  if (typeof _hitlBackend.notify === 'function') return _hitlBackend.notify(message)
  return terminalBackend.notify(message)
}
