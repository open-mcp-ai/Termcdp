#!/usr/bin/env node
/**
 * bundle.mjs —— 零依赖单文件打包器。
 *
 * 这个项目的结构刚好适合朴素打包：全静态 import、无循环依赖、无 default 导出、
 * 只有 bin 里有一处动态 import（懒加载 MCP server，打包时提升为静态）。
 * 所以不需要 AST：按拓扑序把每个模块包成一个命名空间对象，node: 内建统一提升到顶部。
 *
 *   node scripts/bundle.mjs   ->  dist/termcdp.js（可执行）
 *
 * 不做压缩：安全的压缩需要完整解析器（ASI、正则字面量、模板插值的交互太容易翻车），
 * 而这个体积（~160 kB）不值得为它引入一个打包依赖。
 */
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..')
const ENTRY = path.join(ROOT, 'bin', 'termcdp.js')
const OUT = path.join(ROOT, 'dist', 'termcdp.js')

/** 匹配单行静态 import：default / namespace / named 三种（可组合）。 */
const IMPORT_RE =
  /^import\s+(?:(?:([\w$]+)\s*,?\s*)?(?:\*\s+as\s+([\w$]+)\s+)?(?:\{([^}]*)\}\s*)?)?from\s*['"]([^'"]+)['"]\s*;?$/

/** 匹配具名导出声明：export function/class/const/let …。 */
const EXPORT_RE = /^export\s+(async\s+)?(function|class|const|let)\s+([\w$]+)/
/** 匹配纯导出清单：export { a, b as c }。 */
const EXPORT_LIST_RE = /^export\s+\{([^}]*)\}\s*;?$/

const isBuiltin = (spec) => spec.startsWith('node:')

/** 把相对 spec 解析成项目内的规范路径。 */
function resolveSpec(spec, fromFile) {
  if (isBuiltin(spec)) return spec
  const base = path.dirname(fromFile)
  const resolved = path.resolve(base, spec).replace(/\\/g, '/')
  return path.relative(ROOT, resolved).replace(/\\/g, '/')
}

/** 解析 named import 清单里的「本地名 -> 导入名」对。 */
function parseNamedList(raw) {
  const out = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const m = trimmed.match(/^([\w$]+)\s+as\s+([\w$]+)$/)
    if (m) out.push({ local: m[2], imported: m[1] })
    else out.push({ local: trimmed, imported: trimmed })
  }
  return out
}

/** 收集每个模块的导出名（用于生成命名空间对象的返回值）。 */
function collectExports(src, nsName) {
  const names = []
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m = line.match(EXPORT_RE)
    if (m) {
      names.push(m[3])
      continue
    }
    m = line.match(EXPORT_LIST_RE)
    if (m) {
      for (const { local } of parseNamedList(m[1])) names.push(local)
    }
  }
  return [...new Set(names)]
}

/** 把一个模块改写成「去掉 import/export 关键字、导出变正常声明」的函数体。 */
function stripModuleSyntax(src, fileId, mod) {
  const out = []
  for (const line of src.split('\n')) {
    const importMatch = line.match(IMPORT_RE)
    if (importMatch) {
      const [, def, ns, namedRaw, spec] = importMatch
      if (isBuiltin(spec)) continue // 内建统一提升，模块内不重复
      const target = resolveSpec(spec, fileId)
      // 拓扑序保证 $target 在本模块之前求值，直接取具名导出即可
      if (def) out.push(`const ${def} = ${mod(target)}.default;`)
      if (ns) out.push(`const ${ns} = ${mod(target)};`)
      for (const { local, imported } of namedRaw ? parseNamedList(namedRaw) : []) {
        out.push(`const ${local} = ${mod(target)}.${imported};`)
      }
      continue
    }
    let m = line.match(EXPORT_RE)
    if (m) {
      out.push(line.replace(/^export\s+/, ''))
      continue
    }
    m = line.match(EXPORT_LIST_RE)
    if (m) continue
    out.push(line)
  }
  return out.join('\n')
}

async function main() {
  // 1) 从入口走依赖图，收集所有模块（拓扑序由 BFS 顺序 + 反转保证）
  const modules = new Map() // fileId -> { src, deps: [fileId], builtinImports: [] }
  const queue = [path.relative(ROOT, ENTRY).replace(/\\/g, '/')]
  const seen = new Set()

  while (queue.length) {
    const fileId = queue.shift()
    if (seen.has(fileId)) continue
    seen.add(fileId)
    const full = path.join(ROOT, fileId)
    if (!existsSync(full)) throw new Error(`missing module: ${fileId}`)
    const src = await fs.readFile(full, 'utf8')
    const deps = []
    const builtinImports = []
    const dynamicImports = []
    for (const line of src.split('\n')) {
      const m = line.match(IMPORT_RE)
      if (m) {
        const spec = m[4]
        if (isBuiltin(spec)) {
          builtinImports.push({ raw: line.trim().replace(/;$/, '') })
          continue
        }
        deps.push(resolveSpec(spec, fileId))
        continue
      }
      // 动态 import（bin 里懒加载 MCP server）：要进依赖图，但保留原语句由入口统一改写
      for (const dyn of line.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (isBuiltin(dyn[1])) continue
        dynamicImports.push({ spec: resolveSpec(dyn[1], fileId), raw: dyn[0] })
      }
    }
    modules.set(fileId, { src, deps, builtinImports, dynamicImports })
    for (const d of deps) if (!seen.has(d)) queue.push(d)
    for (const d of dynamicImports) if (!seen.has(d.spec)) queue.push(d.spec)
  }

  // 2) 拓扑排序（依赖在前）
  const sorted = []
  const visited = new Set()
  const visit = (id) => {
    if (visited.has(id)) return
    visited.add(id)
    const mod = modules.get(id)
    for (const d of mod.deps) visit(d)
    for (const d of mod.dynamicImports) visit(d.spec)
    sorted.push(id)
  }
  for (const id of modules.keys()) visit(id)

  // 3) node: 内建按模块合并具名绑定，提升到 bundle 顶部
  const builtinByName = new Map() // spec -> { defaults: Set, named: Map(local->imported), namespaces: Set }
  for (const id of sorted) {
    for (const b of modules.get(id).builtinImports) {
      const m = b.raw.match(/^import\s+(?:(?:([\w$]+)\s*,?\s*)?(?:\*\s+as\s+([\w$]+)\s+)?(?:\{([^}]*)\}\s*)?)?from\s*['"]([^'"]+)['"]\s*;?$/)
      if (!m) continue
      const [, def, ns, namedRaw, spec] = m
      if (!builtinByName.has(spec)) builtinByName.set(spec, { defaults: new Set(), named: new Map(), namespaces: new Set() })
      const slot = builtinByName.get(spec)
      if (def) slot.defaults.add(def)
      if (ns) slot.namespaces.add(ns)
      for (const { local, imported } of namedRaw ? parseNamedList(namedRaw) : []) slot.named.set(local, imported)
    }
  }
  const builtins = []
  for (const [spec, slot] of builtinByName) {
    const parts = []
    if (slot.defaults.size > 1) throw new Error(`conflicting default imports for ${spec}: ${[...slot.defaults].join(', ')}`)
    if (slot.defaults.size === 1) parts.push(slot.defaults.values().next().value)
    const named = [...slot.named.entries()].map(([local, imported]) =>
      local === imported ? local : `${imported} as ${local}`,
    )
    if (named.length) parts.push(`{ ${named.join(', ')} }`)
    for (const ns of slot.namespaces) parts.push(`* as ${ns}`)
    builtins.push(`import ${parts.join(', ')} from '${spec}'`)
  }

  // 4) bin 入口里的动态 import 提升为对已打包命名空间的直接引用
  const entryRel = path.relative(ROOT, ENTRY).replace(/\\/g, '/')
  const entry = modules.get(entryRel)
  const nsName = (fileId) => '$' + fileId.replace(/[/.-]/g, '_').replace(/^_/, '')
  let entryBody = stripModuleSyntax(entry.src, entryRel, nsName).replace(/^#!.*\n?/m, '')
  for (const dyn of entry.dynamicImports) {
    entryBody = entryBody.split(dyn.raw).join(`Promise.resolve(${nsName(dyn.spec)})`)
  }

  // 5) 组装
  const header = [
    '#!/usr/bin/env node',
    '/**',
    ' * termcdp —— single-file build (auto-generated; do not edit).',
    ' * 打包命令：npm run bundle',
    ' */',
  ]

  const moduleBlocks = []
  for (const id of sorted) {
    if (id === entryRel) continue
    const mod = modules.get(id)
    const ns = nsName(id)
    const exports = collectExports(mod.src, ns)
    const body = stripModuleSyntax(mod.src, id, nsName)
    const block = [
      `const ${ns} = (() => {`,
      body,
      `  return { ${exports.join(', ')} }`,
      `})()`,
    ]
    moduleBlocks.push(block.join('\n'))
  }

  const parts = [...header, '', ...builtins, '', ...moduleBlocks, '', entryBody, '']
  const bundle = parts.join('\n')

  await fs.mkdir(path.dirname(OUT), { recursive: true })
  await fs.writeFile(OUT, bundle)
  await fs.chmod(OUT, 0o755)
  const bytes = Buffer.byteLength(bundle)
  console.log(`bundle -> ${path.relative(ROOT, OUT)} (${(bytes / 1024).toFixed(1)} kB)`)
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exit(1)
})
