// dirs.js — flowcast 目录约定
//
// 新项目使用 .flowcast/，旧项目 .flowx/ 向后兼容。
// 规则：.flowcast/ 存在则用它，否则 fallback 到 .flowx/（旧项目无需迁移）。

import { existsSync } from 'fs'
import { join } from 'path'

/**
 * 返回项目的 flowcast 数据根目录。
 * 新项目：<repo>/.flowcast/
 * 旧项目兼容：<repo>/.flowx/（.flowcast/ 不存在时）
 */
export function flowcastDir(repo = process.cwd()) {
  const fc = join(repo, '.flowcast')
  return existsSync(fc) ? fc : join(repo, '.flowx')
}
