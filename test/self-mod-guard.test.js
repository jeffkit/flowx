import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

import { withSelfModGuard, captureBaseline } from '../self-mod-guard.js'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 建一个带初始 commit 的临时 git 仓。 */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'flowx-guard-'))
  git(['init', '-q'], repo)
  git(['config', 'user.email', 't@t'], repo)
  git(['config', 'user.name', 't'], repo)
  writeFileSync(join(repo, 'a.txt'), 'baseline\n')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'init'], repo)
  return repo
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true })
}

test('captureBaseline 无 commit 时抛错', () => {
  const repo = mkdtempSync(join(tmpdir(), 'flowx-guard-empty-'))
  git(['init', '-q'], repo)
  assert.throws(() => captureBaseline(repo), /无 baseline commit/)
  cleanup(repo)
})

test('captureBaseline 工作树脏时抛错（requireClean）', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'a.txt'), 'dirty\n')
  assert.throws(() => captureBaseline(repo), /工作树不干净/)
  cleanup(repo)
})

test('fn 抛错 → 硬回滚到 baseline，工作树干净', async () => {
  const repo = makeRepo()
  const baseline = git(['rev-parse', 'HEAD'], repo)
  await assert.rejects(
    withSelfModGuard(async () => {
      writeFileSync(join(repo, 'a.txt'), 'mutated\n')
      writeFileSync(join(repo, 'new.txt'), 'junk\n')
      throw new Error('boom')
    }, { repo }),
    /boom/,
  )
  assert.equal(git(['rev-parse', 'HEAD'], repo), baseline)
  assert.equal(git(['status', '--porcelain'], repo), '', '工作树应干净')
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'baseline\n')
  assert.equal(existsSync(join(repo, 'new.txt')), false, 'untracked 文件应被 clean')
  cleanup(repo)
})

test("verdict='rolled-back' → 回滚", async () => {
  const repo = makeRepo()
  const r = await withSelfModGuard(async () => {
    writeFileSync(join(repo, 'a.txt'), 'mutated\n')
    return { verdict: 'rolled-back', reason: 'gate-red' }
  }, { repo })
  assert.equal(r.verdict, 'rolled-back')
  assert.equal(git(['status', '--porcelain'], repo), '')
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'baseline\n')
  cleanup(repo)
})

test("verdict='panic-preserved' → 保留现场不回滚", async () => {
  const repo = makeRepo()
  const r = await withSelfModGuard(async () => {
    writeFileSync(join(repo, 'a.txt'), 'panic-state\n')
    return { verdict: 'panic-preserved' }
  }, { repo })
  assert.equal(r.verdict, 'panic-preserved')
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'panic-state\n', '应保留脏现场')
  cleanup(repo)
})

test("verdict='committed' → 不回滚，保留 commit", async () => {
  const repo = makeRepo()
  const baseline = git(['rev-parse', 'HEAD'], repo)
  const r = await withSelfModGuard(async () => {
    writeFileSync(join(repo, 'a.txt'), 'committed-change\n')
    git(['add', '.'], repo)
    git(['commit', '-q', '-m', 'work'], repo)
    return { verdict: 'committed' }
  }, { repo })
  assert.equal(r.verdict, 'committed')
  assert.notEqual(git(['rev-parse', 'HEAD'], repo), baseline)
  assert.equal(r.baseline, baseline)
  cleanup(repo)
})
