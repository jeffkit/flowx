import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  recursive, spawnCapture,
  setHitlBackend, getHitlBackend, waitForInput, notify,
} from '../agent.js'

// 假的 recursive 二进制：按 FAKE_MODE 控制输出/退出码，并按 --transcript-out 写 transcript。
const FAKE_BIN = `#!/bin/sh
TRANSCRIPT=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--transcript-out" ]; then TRANSCRIPT="$a"; fi
  prev="$a"
done
if [ -n "$TRANSCRIPT" ]; then
  printf '{"messages":[{"role":"user"},{"role":"assistant"},{"role":"tool"}]}' > "$TRANSCRIPT"
fi
case "$FAKE_MODE" in
  budget) echo "[done after 2 steps] reason: BudgetExceeded"; exit 0 ;;
  panic)  echo "thread 'main' panicked at boom"; exit 101 ;;
  *)      echo "[done after 3 steps] reason: Done"; exit 0 ;;
esac
`

function makeFakeBin() {
  const dir = mkdtempSync(join(tmpdir(), 'flowx-recbin-'))
  const bin = join(dir, 'recursive')
  writeFileSync(bin, FAKE_BIN)
  chmodSync(bin, 0o755)
  return { dir, bin }
}

// ── spawnCapture ──────────────────────────────────────────────────

test('spawnCapture 不因非零退出 reject，返回 exitCode', async () => {
  const r = await spawnCapture('sh', ['-c', 'echo hi; exit 7'])
  assert.equal(r.exitCode, 7)
  assert.match(r.stdout, /hi/)
  assert.equal(r.timedOut, false)
})

test('spawnCapture 合并 stderr', async () => {
  const r = await spawnCapture('sh', ['-c', 'echo err >&2'])
  assert.match(r.stdout, /err/)
})

// ── recursive adapter ─────────────────────────────────────────────

test('recursive 正常结束：finishReason + transcriptMessages', async () => {
  const { dir, bin } = makeFakeBin()
  const tOut = join(dir, 't.json')
  const out = await recursive('do something', { bin, cwd: dir, transcriptOut: tOut })
  assert.equal(out._meta.cli, 'recursive')
  assert.equal(out._meta.exitCode, 0)
  assert.equal(out._meta.budgetExceeded, false)
  assert.equal(out._meta.panicked, false)
  assert.equal(out._meta.finishReason, 'Done')
  assert.equal(out._meta.transcriptMessages, 3)
  rmSync(dir, { recursive: true, force: true })
})

test('recursive BudgetExceeded 被识别', async () => {
  const { dir, bin } = makeFakeBin()
  const out = await recursive('g', { bin, cwd: dir, env: { FAKE_MODE: 'budget' } })
  assert.equal(out._meta.budgetExceeded, true)
  assert.equal(out._meta.finishReason, 'BudgetExceeded')
  rmSync(dir, { recursive: true, force: true })
})

test('recursive panic（exit 101）被识别', async () => {
  const { dir, bin } = makeFakeBin()
  const out = await recursive('g', { bin, cwd: dir, env: { FAKE_MODE: 'panic' } })
  assert.equal(out._meta.panicked, true)
  assert.equal(out._meta.exitCode, 101)
  rmSync(dir, { recursive: true, force: true })
})

test('recursive 二进制不存在 → spawnError，不抛', async () => {
  const out = await recursive('g', { bin: '/nonexistent/recursive-xyz', cwd: tmpdir() })
  assert.ok(out._meta.spawnError, '应记录 spawnError')
  assert.equal(out._meta.exitCode, -1)
})

// ── HITL 可插拔后端 ───────────────────────────────────────────────

test('默认后端是 terminal', () => {
  setHitlBackend('terminal')
  const b = getHitlBackend()
  assert.equal(typeof b.waitForInput, 'function')
  assert.equal(typeof b.notify, 'function')
})

test('wecom 后端（注入函数）：waitForInput 走 sendAndWait 并带 project_name', async () => {
  const calls = []
  setHitlBackend('wecom', {
    projectName: 'flowx',
    sendAndWait: async (msg, ctx) => { calls.push(['wait', msg, ctx]); return 'human says yes' },
    send: async (msg, ctx) => { calls.push(['notify', msg, ctx]) },
  })
  const reply = await waitForInput('approve?')
  assert.equal(reply, 'human says yes')
  await notify('done')
  assert.equal(calls[0][0], 'wait')
  assert.equal(calls[0][1], 'approve?')
  assert.equal(calls[0][2].projectName, 'flowx')
  assert.equal(calls[1][0], 'notify')
  assert.equal(calls[1][1], 'done')
  setHitlBackend('terminal')
})

test('自定义 backend 对象可直接注入', async () => {
  const seen = []
  setHitlBackend({
    async waitForInput(p) { seen.push(p); return 'ok' },
    async notify(m) { seen.push(m) },
  })
  assert.equal(await waitForInput('q'), 'ok')
  await notify('n')
  assert.deepEqual(seen, ['q', 'n'])
  setHitlBackend('terminal')
})

test('未知后端抛错', () => {
  assert.throws(() => setHitlBackend('telegram'), /未知 HITL 后端/)
})

test('notify 在后端无 notify 时回退终端（不抛）', async () => {
  setHitlBackend({ async waitForInput() { return '' } }) // 无 notify
  await assert.doesNotReject(notify('fallback message'))
  setHitlBackend('terminal')
})
