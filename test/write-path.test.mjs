/**
 * "Write where the row actually lives" tests.
 *
 * An MCP row normally sits inside an `- insert:` block. `configEditor.edit()`
 * can only write an id-targeted override row at the top level, so using it on
 * an insert row appends a *second* definition and leaves the original in
 * effect — the edit silently does nothing while the file grows.
 *
 * These tests pin the distinction the host handler now makes: replace the row
 * in place, so exactly one definition of the id exists afterwards.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'

import * as YAML from 'yaml'

import { editPatch, joinLines, removeRow, replaceRow, scanStructure, splitLines } from '../src/patch-edit.mjs'
import { finalizeDraft, installYamlRuntime, toDshEntry } from '../src/parse.mjs'

installYamlRuntime(YAML)

/** A patch with one insert block holding one MCP row, plus sibling rows. */
const FIXTURE = `- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: C:/nvm4w/nodejs/node.exe
        cwd: !!js process.cwd()
        toolCallTimeoutMs: 60000
- id: tool-godot-bridge
  config:
    godotPath: D:/DevTools/Godot/Godot.exe
`

/**
 * @param {string} text
 * @returns {string[]}
 */
function ids(text) {
  return text.match(/^\s*-\s+id:\s*(\S+)/gm)?.map((line) => line.replace(/^[\s-]*id:\s*/, '')) ?? []
}

test('replacing an insert row leaves exactly one definition of its id', () => {
  const { lines, eol } = splitLines(FIXTURE)
  const row = toDshEntry(
    finalizeDraft({
      serverName: 'rea',
      transport: 'stdio',
      command: 'C:/nvm4w/nodejs/node.exe',
      cwd: { __jsExpr: 'process.cwd()' },
      toolCallTimeoutMs: 90000,
      id: 'rea-mcp',
    }),
    { id: 'rea-mcp' },
  )

  const next = replaceRow(lines, eol, 'rea-mcp', row)
  const text = joinLines(next, eol, true)

  assert.deepEqual(
    ids(text).filter((id) => id === 'rea-mcp'),
    ['rea-mcp'],
    'no second row may be appended for the same id',
  )
  assert.ok(!/^\- id: rea-mcp$/m.test(text), 'no top-level override row may appear')

  const doc = YAML.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v) => v }] }).toJS()
  const block = doc.find((entry) => Array.isArray(entry.insert))
  const rea = block.insert.find((entry) => entry.id === 'rea-mcp')
  assert.equal(rea.config.toolCallTimeoutMs, 90000, 'the change takes effect')
  assert.equal(rea.config.cwd, 'process.cwd()', 'the expression survives')
})

test('the scanner tracks insert rows only, which is why in-place replace is required', () => {
  // This is exactly the broken state the old code produced: an override row
  // appended after the insert block, while the original insert row stays.
  // `scanStructure` reports the insert row; `countEntries` sees both — that
  // divergence is why the handler decides by "is the row in the patch?" rather
  // than by handing every id to configEditor.
  const broken = `${FIXTURE}- id: rea-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: rea
    transport: stdio
    command: node
    toolCallTimeoutMs: 90000
`
  const { rows } = scanStructure(splitLines(broken).lines)
  const rea = rows.filter((row) => row.id === 'rea-mcp')
  assert.equal(rea.length, 1, 'the scanner reports the insert row')
  assert.equal(rea[0].inInsert, true)

  // Two `- id: rea-mcp` lines exist in the text, so the duplicate is real.
  assert.equal((broken.match(/- id: rea-mcp/g) ?? []).length, 2)
})

test('replacing an insert row keeps its sibling rows untouched', () => {
  const { lines, eol } = splitLines(FIXTURE)
  const row = toDshEntry(
    finalizeDraft({ serverName: 'rea2', transport: 'stdio', command: 'node', id: 'rea-mcp' }),
    { id: 'rea-mcp' },
  )
  const text = joinLines(replaceRow(lines, eol, 'rea-mcp', row), eol, true)

  assert.ok(text.includes('transcriptView: standard'))
  assert.ok(text.includes('godotPath: D:/DevTools/Godot/Godot.exe'))
  assert.ok(text.includes('serverName: rea2'))
})

test('a round trip through the writer restores the original file', async () => {
  const { lines, eol, trailingNewline } = splitLines(FIXTURE)
  const row = toDshEntry(
    finalizeDraft({
      serverName: 'rea',
      transport: 'stdio',
      command: 'C:/nvm4w/nodejs/node.exe',
      cwd: { __jsExpr: 'process.cwd()' },
      toolCallTimeoutMs: 120000,
      id: 'rea-mcp',
    }),
    { id: 'rea-mcp' },
  )
  const changed = joinLines(replaceRow(lines, eol, 'rea-mcp', row), eol, trailingNewline)
  assert.notEqual(changed, FIXTURE)

  // Removing the row and re-inserting the original must reconstruct the fixture
  // for the parts the writer owns; the surrounding rows are the invariant.
  const without = joinLines(removeRow(lines, 'rea-mcp'), eol, trailingNewline)
  assert.ok(!without.includes('rea-mcp'))
  assert.ok(without.includes('ui-chat'))
  assert.ok(without.includes('tool-godot-bridge'))
})

test('editPatch writes the replaced row to disk', async () => {
  const path = '.research/upd-write.fixture.yml'
  await fs.mkdir('.research', { recursive: true })
  await fs.writeFile(path, FIXTURE, 'utf8')

  const row = toDshEntry(
    finalizeDraft({
      serverName: 'rea',
      transport: 'stdio',
      command: 'node',
      toolCallTimeoutMs: 45000,
      id: 'rea-mcp',
    }),
    { id: 'rea-mcp' },
  )

  const result = await editPatch(path, ({ lines, eol }) => ({
    lines: replaceRow(lines, eol, 'rea-mcp', row),
    expectIds: ['rea-mcp'],
  }))
  assert.equal(result.changed, true)

  const text = await fs.readFile(path, 'utf8')
  assert.equal((text.match(/- id: rea-mcp/g) ?? []).length, 1)
  assert.ok(text.includes('toolCallTimeoutMs: 45000'))
  await fs.rm(path, { force: true })
})
