import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { writeFailureContext, readAndConsumeFailureContext } from '../failure-context.js'

test('写入后可读取，内容含 reason / tailLog / provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fc-'))
  const p = writeFailureContext(dir, 'attempt', {
    reason: 'BudgetExceeded',
    tailLog: 'last log line',
    provider: 'anthropic',
    model: 'sonnet',
  })
  assert.equal(existsSync(p), true)
  const content = readAndConsumeFailureContext(dir, 'attempt')
  assert.match(content, /BudgetExceeded/)
  assert.match(content, /last log line/)
  assert.match(content, /anthropic/)
  assert.match(content, /sonnet/)
  assert.match(content, /Do NOT repeat/)
  rmSync(dir, { recursive: true, force: true })
})

test('读取即消费：第二次读返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fc2-'))
  writeFailureContext(dir, 'attempt', { reason: 'x' })
  const first = readAndConsumeFailureContext(dir, 'attempt')
  assert.notEqual(first, null)
  const second = readAndConsumeFailureContext(dir, 'attempt')
  assert.equal(second, null, '消费后应删除，只注入一次')
  rmSync(dir, { recursive: true, force: true })
})

test('不存在时返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fc3-'))
  assert.equal(readAndConsumeFailureContext(dir, 'nope'), null)
  rmSync(dir, { recursive: true, force: true })
})
