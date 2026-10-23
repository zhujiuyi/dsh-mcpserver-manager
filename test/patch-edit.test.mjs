/**
 * Patch editor tests.
 *
 * Every mutation is applied to a fixture modelled on the real profile patch:
 * hand-written comments, `!!js` expressions, a nested `env:` map, and a
 * sibling top-level row whose leading comment must survive.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as YAML from 'yaml'

import {
  PatchEditError,
  insertRow,
  joinLines,
  removeRow,
  replaceRow,
  requireRow,
  scanStructure,
  splitLines,
  validateEdit,
} from '../src/patch-edit.mjs'

/** A fixture with the same structure as the real profile patch. */
const FIXTURE = `# Your patch layer for this dsh profile.
# a top-level YAML array of loader patch entries.
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
# REA — added 2026-10-11
# needs a restart; tools surface as mcp__rea__<tool_name>
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        # explicit timeout, also acts as a config change
        toolCallTimeoutMs: 60000
        command: C:/nvm4w/nodejs/node.exe
        args: [ "rea.mjs", mcp ]
        cwd: !!js process.cwd()
        env:
          JAVA_HOME: "D:/DevTools/JDK"
# godot-bridge — added 2026-10-11
- id: tool-godot-bridge
  config:
    godotPath: D:/DevTools/Godot/Godot.exe
`

/**
 * @param {string} text
 * @returns {{ lines: string[], eol: string }}
 */
function parse(text) {
  const { lines, eol } = splitLines(text)
  return { lines, eol }
}

/**
 * @param {string[]} lines
 * @param {string} eol
 * @returns {string}
 */
function render(lines, eol) {
  return joinLines(lines, eol, true)
}

const NEW_ROW = {
  id: 'mcp-dbx',
  name: '@deepseek-ai/dsh-mcp-client',
  config: {
    serverName: 'dbx',
    transport: 'stdio',
    command: 'C:/Users/zhuji/.dbx/bin/dbx-mcp.exe',
  },
}

test('the scanner finds the insert block and its one row', () => {
  const { lines } = parse(FIXTURE)
  const { blocks, rows } = scanStructure(lines)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].empty, false)
  assert.deepEqual(rows.map((row) => row.id), ['rea-mcp'])
})

test('a row span does not swallow the next top-level row comment', () => {
  const { lines } = parse(FIXTURE)
  const row = requireRow(lines, 'rea-mcp')
  const span = lines.slice(row.rowStart, row.rowEnd)
  assert.ok(span.some((line) => line.includes('JAVA_HOME')))
  assert.ok(
    !span.some((line) => line.includes('godot-bridge')),
    'the comment for the next row must stay outside this row',
  )
})

test('inserting appends inside the existing insert block', () => {
  const { lines, eol } = parse(FIXTURE)
  const next = insertRow(lines, eol, NEW_ROW)
  const text = render(next, eol)

  // Both rows are now in one block.
  const { rows, blocks } = scanStructure(next)
  assert.deepEqual(rows.map((row) => row.id), ['rea-mcp', 'mcp-dbx'])
  assert.equal(blocks.length, 1)

  // The new row reads like a hand-written one.
  assert.match(text, /- id: mcp-dbx\n {6}name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(text, /\n {8}serverName: dbx/)
  assert.match(text, /\n {8}transport: stdio/)
  assert.match(text, /\n {8}command: C:\/Users\/zhuji\/\.dbx\/bin\/dbx-mcp\.exe/)
})

test('inserting leaves every other row and comment byte-identical', () => {
  const { lines, eol } = parse(FIXTURE)
  const next = insertRow(lines, eol, NEW_ROW)
  const text = render(next, eol)

  assert.ok(text.startsWith('# Your patch layer for this dsh profile.'))
  assert.ok(text.includes('cwd: !!js process.cwd()'))
  assert.ok(text.includes('# godot-bridge — added 2026-10-11'))
  assert.ok(text.includes('godotPath: D:/DevTools/Godot/Godot.exe'))
  // The row's own indented comment survives.
  assert.ok(text.includes('# explicit timeout, also acts as a config change'))
})

test('inserting a second row keeps one block and grows it', () => {
  const { lines, eol } = parse(FIXTURE)
  const once = insertRow(lines, eol, NEW_ROW)
  const httpRow = {
    id: 'mcp-web',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'web',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer abc' },
    },
  }
  const twice = insertRow(once, eol, httpRow)
  const { rows, blocks } = scanStructure(twice)
  assert.deepEqual(rows.map((row) => row.id), ['rea-mcp', 'mcp-dbx', 'mcp-web'])
  assert.equal(blocks.length, 1)

  const text = render(twice, eol)
  assert.ok(text.includes('url: http://localhost:3000/mcp'))
  assert.ok(text.includes("Authorization: 'Bearer abc'"))
})

test('inserting into a document with no block appends one', () => {
  const { lines, eol } = parse('- id: other\n  config:\n    a: 1\n')
  const next = insertRow(lines, eol, NEW_ROW)
  const text = render(next, eol)
  assert.match(text, /- id: other\n {2}config:\n {4}a: 1\n- insert:\n/)
  assert.deepEqual(scanStructure(next).rows.map((row) => row.id), ['mcp-dbx'])
})

test('replacing a row swaps its config and keeps its position', () => {
  const { lines, eol } = parse(FIXTURE)
  const next = replaceRow(lines, eol, 'rea-mcp', {
    id: 'rea-mcp',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'rea2',
      transport: 'streamable-http',
      url: 'https://rea.dev/mcp',
    },
  })
  const text = render(next, eol)

  assert.ok(text.includes('serverName: rea2'))
  assert.ok(text.includes('url: https://rea.dev/mcp'))
  assert.ok(!text.includes('JAVA_HOME'), 'the old config is gone')
  assert.ok(text.includes('# godot-bridge — added 2026-10-11'), 'later comments survive')
  assert.ok(text.includes('transcriptView: standard'), 'earlier rows survive')
  assert.deepEqual(scanStructure(next).rows.map((row) => row.id), ['rea-mcp'])
})

test('removing the only row drops the empty insert wrapper', () => {
  const { lines } = parse(FIXTURE)
  const next = removeRow(lines, 'rea-mcp')
  const { blocks, rows } = scanStructure(next)

  assert.deepEqual(rows, [])
  assert.equal(blocks.length, 0, 'no orphan - insert: may remain')

  const text = render(next, '\n')
  assert.ok(!text.includes('insert:'))
  assert.ok(!text.includes('rea-mcp'))
  // Both neighbours survive.
  assert.ok(text.includes('id: ui-chat'))
  assert.ok(text.includes('id: tool-godot-bridge'))
  assert.ok(text.includes('# REA — added 2026-10-11'), 'the block header comment stays')
})

test('insert then remove is an exact round trip', () => {
  const { lines, eol } = parse(FIXTURE)
  const inserted = insertRow(lines, eol, NEW_ROW)
  const removed = removeRow(inserted, 'mcp-dbx')
  assert.equal(render(removed, eol), FIXTURE)
})

test('adding and removing two rows is also an exact round trip', () => {
  const { lines, eol } = parse(FIXTURE)
  const a = insertRow(lines, eol, NEW_ROW)
  const b = insertRow(a, eol, {
    id: 'mcp-web',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'web', transport: 'streamable-http', url: 'http://x.dev/mcp' },
  })
  const rm1 = removeRow(b, 'mcp-web')
  const rm2 = removeRow(rm1, 'mcp-dbx')
  assert.equal(render(rm2, eol), FIXTURE)
})

test('removing one of two rows keeps the block', () => {
  const { lines, eol } = parse(FIXTURE)
  const inserted = insertRow(lines, eol, NEW_ROW)
  const next = removeRow(inserted, 'mcp-dbx')
  const { blocks, rows } = scanStructure(next)
  assert.equal(blocks.length, 1)
  assert.deepEqual(rows.map((row) => row.id), ['rea-mcp'])
})

test('removing an unknown id raises a clear error', () => {
  const { lines } = parse(FIXTURE)
  assert.throws(() => removeRow(lines, 'nope'), PatchEditError)
})

test('values that need quoting are quoted and round-trip through a re-scan', () => {
  const { lines, eol } = parse(FIXTURE)
  const tricky = {
    id: 'mcp-tricky',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'tricky',
      transport: 'stdio',
      command: 'C:/Program Files/My App/run.exe',
      args: ['--flag', 'two words', '-x'],
      env: { A: 'a:b', B: 'has #hash', C: "it's" },
    },
  }
  const next = insertRow(lines, eol, tricky)
  const text = render(next, eol)

  // Quoted where a YAML reader would otherwise misread the value.
  assert.ok(text.includes("command: 'C:/Program Files/My App/run.exe'"))
  assert.ok(text.includes("- '--flag'"))
  assert.ok(text.includes("- '-x'"))
  assert.ok(text.includes("- 'two words'"))
  assert.ok(text.includes("B: 'has #hash'"))
  assert.ok(text.includes("C: 'it''s'"))

  // The scanner can still delimit the row, which is what validation relies on.
  assert.deepEqual(scanStructure(next).rows.map((row) => row.id), ['rea-mcp', 'mcp-tricky'])
})

test('rendered rows parse back to exactly the values that were written', () => {
  const { lines, eol } = parse(FIXTURE)
  const tricky = {
    id: 'mcp-tricky',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'tricky',
      transport: 'stdio',
      command: 'C:/Program Files/My App/run.exe',
      args: ['--flag', 'two words', '-x'],
      env: { A: 'a:b', B: 'has #hash', C: "it's" },
    },
  }
  const text = render(insertRow(lines, eol, tricky), eol)

  // A real YAML parser is the only honest check that the quoting is correct.
  const document = YAML.parse(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
  })
  const block = document.find((row) => Array.isArray(row.insert))
  const written = block.insert.find((row) => row.id === 'mcp-tricky')
  assert.deepEqual(written.config.command, 'C:/Program Files/My App/run.exe')
  assert.deepEqual(written.config.args, ['--flag', 'two words', '-x'])
  assert.deepEqual(written.config.env, { A: 'a:b', B: 'has #hash', C: "it's" })

  // And the untouched rows still parse.
  const rea = block.insert.find((row) => row.id === 'rea-mcp')
  assert.equal(rea.config.serverName, 'rea')
  assert.deepEqual(rea.config.args, ['rea.mjs', 'mcp'])
  assert.equal(document.find((row) => row.id === 'tool-godot-bridge').config.godotPath,
    'D:/DevTools/Godot/Godot.exe')
})

test('CRLF documents are written back as CRLF', () => {
  const crlf = FIXTURE.replace(/\n/g, '\r\n')
  const { lines, eol } = splitLines(crlf)
  assert.equal(eol, '\r\n')
  const next = insertRow(lines, eol, NEW_ROW)
  const text = render(next, eol)
  assert.ok(text.includes('\r\n'))
  assert.equal(text.replace(/\r\n/g, '\n'), render(insertRow(parse(FIXTURE).lines, '\n', NEW_ROW), '\n'))
})

test('validation refuses an edit that lost a row', () => {
  const { lines } = parse(FIXTURE)
  assert.throws(
    () => validateEdit(lines, lines.filter((line) => !line.includes('rea-mcp')), { expectIds: ['rea-mcp'] }),
    PatchEditError,
  )
})

test('validation refuses an edit that changes the row count by more than one', () => {
  const { lines } = parse(FIXTURE)
  // Dropping the MCP block's row *and* the top-level godot row is a two-row
  // swing, which no legitimate single-row operation produces.
  const dropped = lines.filter(
    (line) =>
      !line.includes('insert:') &&
      !line.includes('rea-mcp') &&
      !line.includes('tool-godot-bridge') &&
      !line.includes('godotPath'),
  )
  // Sanity: the fixture really did lose two rows.
  assert.equal(scanStructure(lines).rows.length, 1)
  assert.equal(scanStructure(dropped).rows.length, 0)
  assert.throws(() => validateEdit(lines, dropped, { expectIds: [] }), /条目数量/)
})

test('validation accepts the normal single-row edits', () => {
  const { lines, eol } = parse(FIXTURE)
  const inserted = insertRow(lines, eol, NEW_ROW)
  assert.doesNotThrow(() => validateEdit(lines, inserted, { expectIds: ['mcp-dbx', 'rea-mcp'] }))

  const removed = removeRow(lines, 'rea-mcp')
  assert.doesNotThrow(() => validateEdit(lines, removed, { expectIds: [] }))
})

test('an empty patch document is handled', () => {
  const { lines, eol } = parse('[]\n')
  const next = insertRow(lines, eol, NEW_ROW)
  const text = render(next, eol)
  assert.deepEqual(scanStructure(next).rows.map((row) => row.id), ['mcp-dbx'])
  assert.ok(text.includes('- insert:'))
})

test('rendered rows keep the client package name quoted like the file does', () => {
  const { lines, eol } = parse(FIXTURE)
  const next = insertRow(lines, eol, NEW_ROW)
  const text = render(next, eol)
  // A `@`-leading scalar must be quoted or YAML would read it as a tag.
  assert.ok(text.includes("name: '@deepseek-ai/dsh-mcp-client'"))
})
