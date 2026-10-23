/**
 * `!!js` fidelity tests.
 *
 * The Loader keeps expressions unevaluated in a row's raw config as a
 * `{ __jsExpr: '<source>' }` wrapper. A plugin that edits one field must give
 * the others back exactly as it received them — stringifying the wrapper would
 * write `[object Object]` into a working configuration and break it on the next
 * load. These tests pin that property across the whole chain.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as YAML from 'yaml'

import {
  finalizeDraft,
  installYamlRuntime,
  isJsExpr,
  toDshEntry,
  toDshPreview,
} from '../src/parse.mjs'
import { insertRow, joinLines, replaceRow, scanStructure, splitLines } from '../src/patch-edit.mjs'

installYamlRuntime(YAML)

/** The exact wrapper the Loader hands over for `cwd: !!js process.cwd()`. */
const CWD_EXPR = { __jsExpr: 'process.cwd()' }

/**
 * A resolver for the `!!js` tag that keeps the expression source as a scalar,
 * which is exactly what the Loader's own reader produces.
 */
const JS_SOURCE_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => String(value),
}

test('isJsExpr recognises the wrapper and rejects near-misses', () => {
  assert.equal(isJsExpr(CWD_EXPR), true)
  assert.equal(isJsExpr({ __jsExpr: '' }), true)
  assert.equal(isJsExpr({ __jsExpr: 5 }), false)
  assert.equal(isJsExpr({ other: 1 }), false)
  assert.equal(isJsExpr('process.cwd()'), false)
  assert.equal(isJsExpr(null), false)
  assert.equal(isJsExpr([]), false)
})

test('a !!js cwd survives finalizeDraft unchanged', () => {
  const draft = finalizeDraft({
    serverName: 'rea',
    transport: 'stdio',
    command: 'node',
    cwd: CWD_EXPR,
  })
  assert.deepEqual(draft.cwd, CWD_EXPR)
})

test('a !!js env value survives finalizeDraft instead of becoming [object Object]', () => {
  const draft = finalizeDraft({
    serverName: 'rea',
    transport: 'stdio',
    command: 'node',
    env: { TOKEN: { __jsExpr: 'process.env.GITHUB_TOKEN' }, PLAIN: 'x' },
  })
  assert.deepEqual(draft.env, {
    TOKEN: { __jsExpr: 'process.env.GITHUB_TOKEN' },
    PLAIN: 'x',
  })
})

test('a !!js command is accepted (its value is only known at load time)', () => {
  const draft = finalizeDraft({
    serverName: 'x',
    transport: 'stdio',
    command: { __jsExpr: 'process.env.MCP_CMD' },
  })
  assert.deepEqual(draft.command, { __jsExpr: 'process.env.MCP_CMD' })
})

test('a !!js url is accepted without static URL validation', () => {
  const draft = finalizeDraft({
    serverName: 'x',
    transport: 'streamable-http',
    url: { __jsExpr: "'https://' + process.env.HOST + '/mcp'" },
  })
  assert.deepEqual(draft.url, { __jsExpr: "'https://' + process.env.HOST + '/mcp'" })
})

test('toDshEntry keeps the wrapper rather than flattening it', () => {
  const row = toDshEntry({
    serverName: 'rea',
    transport: 'stdio',
    command: 'node',
    cwd: CWD_EXPR,
    env: { TOKEN: { __jsExpr: 'process.env.T' } },
  })
  assert.deepEqual(row.config.cwd, CWD_EXPR)
  assert.deepEqual(row.config.env, { TOKEN: { __jsExpr: 'process.env.T' } })
})

test('the patch writer renders a !!js value as !!js, never as [object Object]', () => {
  const { lines, eol } = splitLines('- insert:\n    - id: x\n      name: y\n      config:\n        a: 1\n')
  const next = insertRow(lines, eol, {
    id: 'mcp-rea',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'rea', transport: 'stdio', command: 'node', cwd: CWD_EXPR },
  })
  const text = joinLines(next, eol, true)

  assert.ok(text.includes('cwd: !!js process.cwd()'), text)
  assert.ok(!text.includes('[object Object]'), text)

  // A real YAML parse reads it back as a scalar carrying the expression source,
  // which is exactly what the Loader's own reader sees.
  const parsed = YAML.parseDocument(text, { customTags: [JS_SOURCE_TAG] })
  assert.equal(parsed.errors.length, 0, String(parsed.errors[0] ?? ''))
  const doc = parsed.toJS()
  const rows = doc.find((entry) => Array.isArray(entry.insert)).insert
  const row = rows.find((entry) => entry.id === 'mcp-rea')
  assert.ok(row !== undefined, 'the new row is in the insert block')
  assert.equal(row.config.cwd, 'process.cwd()')
})

test('editing one field of a !!js-bearing row preserves every other field', () => {
  // A row exactly like the profile's rea-mcp: several plain fields, one
  // expression in cwd, and an env map with a plain value.
  const before = {
    id: 'rea-mcp',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'rea',
      transport: 'stdio',
      toolCallTimeoutMs: 60000,
      command: 'C:/nvm4w/nodejs/node.exe',
      args: ['rea.mjs', 'mcp'],
      cwd: CWD_EXPR,
      env: { JAVA_HOME: 'D:/DevTools/JDK' },
    },
  }
  const { lines, eol } = splitLines(
    joinLines(
      insertRow(
        splitLines('- insert:\n').lines,
        '\n',
        before,
      ),
      '\n',
      true,
    ),
  )

  // Sanity: the expression is in the document to begin with.
  assert.ok(joinLines(lines, eol, true).includes('!!js process.cwd()'))

  // Change only the timeout, exactly as the UI's edit dialog does.
  const after = replaceRow(lines, eol, 'rea-mcp', {
    ...before,
    config: { ...before.config, toolCallTimeoutMs: 120000 },
  })
  const text = joinLines(after, eol, true)

  assert.ok(text.includes('toolCallTimeoutMs: 120000'), text)
  assert.ok(text.includes('cwd: !!js process.cwd()'), 'the expression must survive')
  assert.ok(text.includes('JAVA_HOME: D:/DevTools/JDK'), 'the env map must survive')
  assert.ok(text.includes('command: C:/nvm4w/nodejs/node.exe'), 'the command must survive')
  assert.ok(!text.includes('[object Object]'))

  const parsed = YAML.parseDocument(text, { customTags: [JS_SOURCE_TAG] })
  assert.equal(parsed.errors.length, 0, String(parsed.errors[0] ?? ''))
  const doc = parsed.toJS()
  const row = doc.find((entry) => Array.isArray(entry.insert)).insert[0]
  assert.equal(row.config.toolCallTimeoutMs, 120000)
  assert.equal(row.config.cwd, 'process.cwd()', 'the expression source survives')
  assert.deepEqual(row.config.env, { JAVA_HOME: 'D:/DevTools/JDK' })
  assert.deepEqual(row.config.args, ['rea.mjs', 'mcp'])
})

test('the preview shows an expression as !!js, not as an object', () => {
  const preview = toDshPreview({
    serverName: 'rea',
    transport: 'stdio',
    command: 'node',
    cwd: CWD_EXPR,
    env: { TOKEN: { __jsExpr: 'process.env.T' } },
  })
  assert.match(preview, /cwd: !!js process\.cwd\(\)/)
  assert.match(preview, /TOKEN=!!js process\.env\.T/)
  assert.ok(!preview.includes('[object Object]'))
})

test('a fully plain config is unaffected by the expression handling', () => {
  const row = toDshEntry({
    serverName: 'dbx',
    transport: 'stdio',
    command: 'dbx-mcp.exe',
    args: ['--x'],
  })
  assert.deepEqual(row.config, {
    serverName: 'dbx',
    transport: 'stdio',
    command: 'dbx-mcp.exe',
    args: ['--x'],
  })
  assert.equal(scanStructure(['- insert:', '    - id: mcp-dbx']).rows.length, 1)
})
