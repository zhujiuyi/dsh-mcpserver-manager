/**
 * Parser tests: the two dialects the user pastes, and the conversion between
 * them. Every case here is a real string from the feature request or from the
 * documented configuration.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as YAML from 'yaml'

import {
  McpConfigError,
  detectDialect,
  finalizeDraft,
  installYamlRuntime,
  parseAny,
  parseClaudeJson,
  parseDshString,
  suggestRowId,
  toClaudeJsonPreview,
  toDshEntry,
  toDshPreview,
} from '../src/parse.mjs'

// The Host half installs the Harness' own YAML implementation at runtime; the
// tests supply the same library directly, since `yaml` ships inside the
// Harness' asar and is not resolvable from a plugin's module graph.
installYamlRuntime(YAML)

/** The dsh patch row from the feature request, verbatim. */
const DSH_ROW = `- insert:
    - id: mcp-dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: "C:\\\\Users\\\\zhuji\\\\.dbx\\\\bin\\\\dbx-mcp.exe"
`

/** The Claude Code block from the feature request, verbatim. */
const CLAUDE_JSON = `{
  "mcpServers": {
    "dbx": {
      "command": "C:\\\\Users\\\\zhuji\\\\.dbx\\\\bin\\\\dbx-mcp.exe"
    }
  }
}`

test('dsh patch row parses into one stdio draft', () => {
  const drafts = parseDshString(DSH_ROW)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].serverName, 'dbx')
  assert.equal(drafts[0].transport, 'stdio')
  assert.equal(drafts[0].command, 'C:\\Users\\zhuji\\.dbx\\bin\\dbx-mcp.exe')
  assert.equal(drafts[0].id, 'mcp-dbx')
})

test('claude code json parses into the same server identity', () => {
  const drafts = parseClaudeJson(CLAUDE_JSON)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].serverName, 'dbx')
  assert.equal(drafts[0].transport, 'stdio')
  assert.equal(drafts[0].command, 'C:\\Users\\zhuji\\.dbx\\bin\\dbx-mcp.exe')
})

test('both dialects normalize to the identical dsh row', () => {
  const fromDsh = toDshEntry(parseDshString(DSH_ROW)[0])
  const fromJson = toDshEntry(parseClaudeJson(CLAUDE_JSON)[0])
  assert.deepEqual(fromDsh, fromJson)
  assert.deepEqual(fromDsh, {
    id: 'mcp-dbx',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'dbx',
      transport: 'stdio',
      command: 'C:\\Users\\zhuji\\.dbx\\bin\\dbx-mcp.exe',
    },
  })
})

test('dialect detection picks json for braces and dsh otherwise', () => {
  assert.equal(detectDialect(CLAUDE_JSON), 'json')
  assert.equal(detectDialect(DSH_ROW), 'dsh')
  assert.equal(detectDialect('@mcp dbx\ntransport: stdio\ncommand: node'), 'dsh')
})

test('auto detection routes each string to its own parser', () => {
  assert.equal(parseAny(CLAUDE_JSON).dialect, 'json')
  assert.equal(parseAny(DSH_ROW).dialect, 'dsh')
})

test('claude http server becomes streamable-http with headers', () => {
  const drafts = parseClaudeJson(JSON.stringify({
    mcpServers: {
      sentry: {
        type: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        headers: { Authorization: 'Bearer abc' },
      },
    },
  }))
  assert.equal(drafts[0].transport, 'streamable-http')
  assert.equal(drafts[0].url, 'https://mcp.sentry.dev/mcp')
  assert.deepEqual(drafts[0].headers, { Authorization: 'Bearer abc' })
})

test('a claude entry with a url and no type is streamable-http', () => {
  const drafts = parseClaudeJson('{"mcpServers":{"x":{"url":"https://e.dev/mcp"}}}')
  assert.equal(drafts[0].transport, 'streamable-http')
})

test('claude args array and env map survive', () => {
  const drafts = parseClaudeJson(JSON.stringify({
    mcpServers: {
      fs: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '~/Projects'],
        env: { LOG_LEVEL: 'info', NUM: 5 },
      },
    },
  }))
  assert.deepEqual(drafts[0].args, ['-y', '@modelcontextprotocol/server-filesystem', '~/Projects'])
  assert.deepEqual(drafts[0].env, { LOG_LEVEL: 'info', NUM: '5' })
})

test('a bare name->config map is accepted', () => {
  const drafts = parseClaudeJson('{"dbx":{"command":"dbx-mcp.exe"}}')
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].serverName, 'dbx')
})

test('the shorthand dialect parses @mcp headers', () => {
  const drafts = parseDshString(`@mcp linear
transport: http
url: https://mcp.linear.app/mcp
headers: Authorization=Bearer TOKEN`)
  assert.equal(drafts[0].serverName, 'linear')
  assert.equal(drafts[0].transport, 'streamable-http')
  assert.deepEqual(drafts[0].headers, { Authorization: 'Bearer TOKEN' })
})

test('the shorthand dialect parses [mcp.name] headers and env.*', () => {
  const drafts = parseDshString(`[mcp.demo]
transport: stdio
command: node
args: a.mjs mcp
env.DEBUG: '1'`)
  assert.equal(drafts[0].serverName, 'demo')
  assert.deepEqual(drafts[0].args, ['a.mjs', 'mcp'])
  assert.deepEqual(drafts[0].env, { DEBUG: '1' })
})

test('several dsh rows in one insert block all parse', () => {
  const text = `- insert:
    - id: mcp-a
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: a
        transport: stdio
        command: cmd-a
    - id: mcp-b
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: b
        transport: streamable-http
        url: https://b.dev/mcp
`
  const drafts = parseDshString(text)
  assert.equal(drafts.length, 2)
  assert.equal(drafts[0].serverName, 'a')
  assert.equal(drafts[1].serverName, 'b')
  assert.equal(drafts[1].transport, 'streamable-http')
})

test('a row whose name is another plugin is refused', () => {
  assert.throws(
    () => parseDshString(`- id: x
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    serverName: x
`),
    McpConfigError,
  )
})

test('sse is refused with a message that explains the fix', () => {
  assert.throws(() => normalizeOrThrow('sse'), /SSE/)
})

/** @param {string} transport */
function normalizeOrThrow(transport) {
  return finalizeDraft({ serverName: 'x', transport, command: 'c' })
}

test('serverName is validated against the client pattern', () => {
  assert.throws(
    () => finalizeDraft({ serverName: 'bad name!', transport: 'stdio', command: 'c' }),
    /不合法/,
  )
  assert.throws(() => finalizeDraft({ serverName: '', transport: 'stdio', command: 'c' }), /缺少服务名称/)
  assert.throws(() => finalizeDraft({ serverName: 'a'.repeat(33), transport: 'stdio', command: 'c' }), /不合法/)
})

test('stdio without command is refused; http without url is refused', () => {
  assert.throws(() => finalizeDraft({ serverName: 'x', transport: 'stdio' }), /缺少 command/)
  assert.throws(
    () => finalizeDraft({ serverName: 'x', transport: 'streamable-http' }),
    /缺少 url/,
  )
  assert.throws(
    () => finalizeDraft({ serverName: 'x', transport: 'streamable-http', url: 'ftp://a/b' }),
    /http/,
  )
})

test('row id is derived from serverName', () => {
  assert.equal(suggestRowId('dbx'), 'mcp-dbx')
  assert.equal(suggestRowId('my server'), 'mcp-my-server')
  assert.equal(suggestRowId(''), 'mcp-server')
})

test('dsh preview round-trips through the parser', () => {
  const draft = parseClaudeJson(CLAUDE_JSON)[0]
  const preview = toDshPreview(draft)
  assert.match(preview, /^@mcp dbx/)
  assert.match(preview, /transport: stdio/)
  // The preview is display text, but it stays parseable.
  const reparsed = parseDshString(preview)
  assert.equal(reparsed[0].serverName, 'dbx')
  assert.equal(reparsed[0].command, draft.command)
})

test('claude preview round-trips through the json parser', () => {
  const draft = parseDshString(DSH_ROW)[0]
  const preview = toClaudeJsonPreview(draft)
  const reparsed = parseClaudeJson(preview)
  assert.equal(reparsed[0].serverName, 'dbx')
  assert.equal(reparsed[0].command, draft.command)
})

test('empty input is refused with a clear message', () => {
  assert.throws(() => parseDshString(''), /为空/)
  assert.throws(() => parseClaudeJson(''), /为空/)
  assert.throws(() => parseClaudeJson('{}'), /mcpServers/)
  assert.throws(() => parseClaudeJson('not json'), /JSON 解析失败/)
})

test('a draft that never states a timeout produces a row without one', () => {
  const draft = finalizeDraft({ serverName: 'x', transport: 'stdio', command: 'c' })
  // The client applies its own 60 000 ms default; writing it out would make a
  // freshly added server noisier than the documented example.
  assert.equal(draft.toolCallTimeoutMs, undefined)
  const row = toDshEntry(draft)
  assert.equal(row.config.toolCallTimeoutMs, undefined)
})

test('an explicitly stated timeout survives even when it equals the default', () => {
  // A row that already carries `toolCallTimeoutMs: 60000` must keep it: an edit
  // that only touched another field must not silently drop a stated value.
  const draft = finalizeDraft({
    serverName: 'x',
    transport: 'stdio',
    command: 'c',
    toolCallTimeoutMs: 60000,
  })
  assert.equal(draft.toolCallTimeoutMs, 60000)
  assert.equal(toDshEntry(draft).config.toolCallTimeoutMs, 60000)
})

test('a non-default timeout is preserved in the row', () => {
  const draft = finalizeDraft({
    serverName: 'x',
    transport: 'stdio',
    command: 'c',
    toolCallTimeoutMs: 5000,
  })
  assert.equal(toDshEntry(draft).config.toolCallTimeoutMs, 5000)
})
