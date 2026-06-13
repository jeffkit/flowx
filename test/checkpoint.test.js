import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Checkpoint } from '../checkpoint.js'

function tempDir() { return mkdtempSync(join(tmpdir(), 'flowcast-cp-')) }

test('Checkpoint.record/has: 同步记录已算好的结果，可被 has 命中', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r1', dir)
    assert.equal(cp.has('g.a'), false)
    const v = cp.record('g.a', { success: true, reason: 'ok' })
    assert.deepEqual(v, { success: true, reason: 'ok' })
    assert.equal(cp.has('g.a'), true)
    // 落盘可被新实例读回（续跑语义）
    const cp2 = new Checkpoint('r1', dir)
    assert.equal(cp2.has('g.a'), true)
    assert.deepEqual(cp2.state.completed['g.a'], { success: true, reason: 'ok' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.record: 并发回调按 fan-out 方式写多个 key 都不丢', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r2', dir)
    // 模拟多个子任务并发完成后各自 record（record 同步，不会交错丢写）
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(async (k) => {
      await new Promise(res => setTimeout(res, Math.random() * 10))
      cp.record(`g.${k}`, { success: true })
    }))
    for (const k of ['a', 'b', 'c', 'd', 'e']) assert.equal(cp.has(`g.${k}`), true)
    // state.json 最终包含全部 5 条
    const onDisk = JSON.parse(readFileSync(join(dir, 'r2', 'state.json'), 'utf8'))
    assert.equal(Object.keys(onDisk.completed).length, 5)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.event：结构化事件追加进 run.log.jsonl（不进 state.json）', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('rev', dir)
    cp.event('fallback', { from: 'a', to: 'b', reason: '429' })
    cp.event('gate', { name: 'test', status: 'fail', exitCode: 101 })
    const lines = readFileSync(join(dir, 'rev', 'run.log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].event, 'fallback')
    assert.equal(lines[0].reason, '429')
    assert.ok(lines[0].ts, '事件应带时间戳')
    assert.equal(lines[1].event, 'gate')
    // 事件不该污染 state.json
    const state = JSON.parse(readFileSync(join(dir, 'rev', 'state.json'), 'utf8'))
    assert.equal(state.steps.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step：自动捕获 agent 结果的 _meta(model/token) 进步骤记录', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('rmeta', dir)
    // 模拟 adapter 返回：字符串 + 挂在 String 包装对象上的 _meta
    const agentResult = Object.assign(String('done'), {
      _meta: { cli: 'claude', model: 'claude-sonnet', inputTokens: 1200, outputTokens: 340 },
    })
    await cp.step('p1.impl', async () => agentResult)
    const onDisk = JSON.parse(readFileSync(join(dir, 'rmeta', 'state.json'), 'utf8'))
    const step = onDisk.steps.find(s => s.key === 'p1.impl')
    assert.equal(step.cli, 'claude')
    assert.equal(step.model, 'claude-sonnet')
    assert.equal(step.inputTokens, 1200)
    assert.equal(step.outputTokens, 340)
    // completed 仍是纯字符串（不被 _meta 污染）
    assert.equal(onDisk.completed['p1.impl'], 'done')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint 报告：record 的步骤无 durationMs 时渲染 "-" 而非 "NaNs"', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('rnan', dir)
    cp.record('group.a', { success: true })   // record 不带 durationMs
    cp.done({ done: 1 })
    const report = readFileSync(join(dir, 'rnan', 'report.md'), 'utf8')
    assert.ok(!report.includes('NaN'), '报告不应出现 NaN')
    assert.match(report, /\| group\.a \| done \| - \|/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step 仍跳过已 record 的 key', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r3', dir)
    cp.record('s1', 'pre-done')
    let ran = false
    const out = await cp.step('s1', async () => { ran = true; return 'fresh' })
    assert.equal(ran, false)        // 已记录 → 不再执行
    assert.equal(out, 'pre-done')   // 返回已存结果
    assert.ok(existsSync(join(dir, 'r3', 'state.json')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: 重入同一 key 抛错（并发双重执行保护）', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-reentry', dir)
    // 第一个 step 还在异步等待中，第二个用相同 key 立刻 step → 应抛错
    let firstStarted = false
    const first = cp.step('s1', async () => {
      firstStarted = true
      await new Promise(res => setTimeout(res, 50))  // 故意挂着
      return 'first'
    })
    // 等第一个开始执行后，立刻并发第二个
    await new Promise(res => setTimeout(res, 5))
    assert.equal(firstStarted, true)
    await assert.rejects(
      () => cp.step('s1', async () => 'second'),
      /in-flight/,
    )
    await first  // 第一个正常完成
    assert.equal(cp.state.completed['s1'], 'first')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: fn 抛错后 _inFlight 清理，同一 key 可重试', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-retry', dir)
    await assert.rejects(
      () => cp.step('s1', async () => { throw new Error('boom') }),
      /boom/,
    )
    // 失败后 inFlight 应已清理，可以重试
    const out = await cp.step('s1', async () => 'recovered')
    assert.equal(out, 'recovered')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
