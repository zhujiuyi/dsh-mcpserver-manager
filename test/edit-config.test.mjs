/**
 * The edit dialog must offer the same two ways in as the add dialog, and both
 * must round-trip a real profile row without losing a field.
 *
 * The round-trip cases matter more than they look: the edit buffer is prefilled
 * from the profile and saved back verbatim, so a renderer that drops a field
 * (a `!!js` working directory, a configured timeout) would silently rewrite a
 * working configuration the moment the user opened the dialog and clicked save.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  finalizeDraft,
  parseClaudeJson,
  parseDshString,
  toClaudeJsonPreview,
  toDshPreview,
} from '../src/parse.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client', 'client.js')

/** A row shaped like the real profile: expression cwd, six env vars, a timeout. */
const REAL_ROW = {
  serverName: 'rea',
  transport: 'stdio',
  command: 'C:/nvm4w/nodejs/node.exe',
  args: ['C:/nvm4w/nodejs/node_modules/rea-agents/scripts/rea.mjs', 'mcp'],
  env: {
    GHIDRA_INSTALL_DIR: 'D:/DevTools/Ghidra/ghidra_12.1.4_PUBLIC',
    JAVA_HOME: 'D:/DevTools/JDK/jdk-21.0.12.1+1',
  },
  cwd: { __jsExpr: 'process.cwd()' },
  url: '',
  headers: {},
  toolCallTimeoutMs: 60000,
}

test('the dsh shorthand round-trips a real row without loss', () => {
  const text = toDshPreview(REAL_ROW)
  const back = finalizeDraft(parseDshString(text)[0])
  assert.deepEqual(back, finalizeDraft(REAL_ROW))
})

test('the dsh shorthand keeps a !!js working directory as an expression', () => {
  const text = toDshPreview(REAL_ROW)
  assert.ok(text.includes('cwd: !!js process.cwd()'), text)
  const back = finalizeDraft(parseDshString(text)[0])
  // A literal string here would be quoted by the patch writer and stop being an
  // expression, silently changing what the server does.
  assert.deepEqual(back.cwd, { __jsExpr: 'process.cwd()' })
})

test('the dsh shorthand keeps a configured timeout', () => {
  const text = toDshPreview(REAL_ROW)
  assert.ok(text.includes('toolCallTimeoutMs: 60000'), text)
  const back = finalizeDraft(parseDshString(text)[0])
  assert.equal(back.toolCallTimeoutMs, 60000)
})

test('the JSON block round-trips a real row without loss', () => {
  const text = toClaudeJsonPreview(REAL_ROW)
  const back = finalizeDraft(parseClaudeJson(text)[0])
  assert.deepEqual(back, finalizeDraft(REAL_ROW))
})

test('the JSON block carries cwd, timeout and the startup flag', () => {
  const text = toClaudeJsonPreview({ ...REAL_ROW, failOnStartupError: true })
  const block = JSON.parse(text)
  const entry = block.mcpServers.rea
  assert.deepEqual(entry.cwd, { __jsExpr: 'process.cwd()' })
  assert.equal(entry.toolCallTimeoutMs, 60000)
  assert.equal(entry.failOnStartupError, true)
})

test('a !!js env value survives the shorthand round trip', () => {
  const draft = {
    ...REAL_ROW,
    env: { TOKEN_PATH: { __jsExpr: 'os.homedir() + "/t"' } },
  }
  const text = toDshPreview(draft)
  const back = finalizeDraft(parseDshString(text)[0])
  assert.deepEqual(back.env.TOKEN_PATH, { __jsExpr: 'os.homedir() + "/t"' })
})

test('the edit dialog offers a configuration tab and a form tab', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const edit = source.slice(source.indexOf('function EditDialog'), source.indexOf('function AddDialog'))

  assert.ok(edit.includes("t('tabConfig')"), 'a config-text tab')
  assert.ok(edit.includes("t('tabManual')"), 'the form tab')
  assert.ok(edit.includes('mcpm-edit-config'), 'an editable textarea for the configuration')
  assert.ok(edit.includes("api('parse'"), 'the text is parsed the same way the add dialog parses it')
  assert.ok(edit.includes("api('update'"), 'saving goes through update')
})

test('the edit buffer is prefilled from the profile, not left empty', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const edit = source.slice(source.indexOf('function EditDialog'), source.indexOf('function AddDialog'))
  // Prefilled with the host's rendering of the current row, so the user edits
  // what is actually stored rather than a blank box.
  assert.ok(edit.includes('payload.preview?.dsh'), 'prefilled from the host preview')
  assert.ok(edit.includes('setText('), 'and put into the buffer')
})

test('an edit that parses to more than one server is refused', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const edit = source.slice(source.indexOf('function EditDialog'), source.indexOf('function AddDialog'))
  // Editing one row must not quietly add or overwrite siblings.
  assert.ok(edit.includes('items.length > 1'), 'multiple items are rejected')
  assert.ok(edit.includes("t('editOneOnly')"), 'with an explanation')
})

test('a config tab with nothing parseable cannot be submitted', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const edit = source.slice(source.indexOf('function EditDialog'), source.indexOf('function AddDialog'))
  assert.ok(
    edit.includes("submitDisabled: tab === 'config' && usable.length !== 1"),
    'the save button waits for exactly one parsed server',
  )
})
