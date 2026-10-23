/**
 * Inventory tests.
 *
 * The shape of `loader.entries()` and `tools.view()` is the whole risk surface
 * here: the real Loader returns a **generator**, and the real tool registry
 * returns a `Map`. An `Array.isArray` guard around the generator silently
 * produced an empty inventory in the running Harness — the failure mode this
 * file exists to prevent.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONNECTION_STATES, createInventoryService, jsonSafe } from '../src/inventory.mjs'

/**
 * Build a service over the supplied fakes.
 * @param {object} options
 * @returns {any}
 */
function service(options) {
  return createInventoryService({
    loader: options.loader,
    tools: options.tools ?? (() => ({ view: () => ({ visible: new Map() }) })),
    patchPath: options.patchPath ?? (() => 'C:/profile/cordis.patch.yml'),
    warn: options.warn,
  })
}

/**
 * @param {object} overrides
 * @returns {object}
 */
function mcpEntry(overrides = {}) {
  return {
    options: {
      id: 'rea-mcp',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'rea',
        transport: 'stdio',
        command: 'C:/node/node.exe',
        args: ['rea.mjs', 'mcp'],
        toolCallTimeoutMs: 60000,
      },
    },
    fiber: { state: 2 },
    ...overrides,
  }
}

test('a generator entries() is walked, not discarded', () => {
  function* entries() {
    yield mcpEntry()
    yield { options: { id: 'other', name: '@deepseek-ai/dsh-llm-deepseek', config: {} }, fiber: { state: 2 } }
  }
  const snapshot = service({ loader: () => ({ entries }) }).snapshot()
  assert.deepEqual(snapshot.servers.map((server) => server.id), ['rea-mcp'])
})

test('an array entries() still works', () => {
  const snapshot = service({
    loader: () => ({ entries: () => [mcpEntry()] }),
  }).snapshot()
  assert.deepEqual(snapshot.servers.map((server) => server.id), ['rea-mcp'])
})

test('non-MCP rows are ignored and duplicates are reported', () => {
  const snapshot = service({
    loader: () => ({
      entries: function* () {
        yield mcpEntry()
        yield { options: { id: 'llm', name: '@deepseek-ai/dsh-llm-deepseek', config: {} }, fiber: { state: 2 } }
        // A second row reusing the same serverName.
        yield mcpEntry({
          options: { id: 'rea-2', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'rea', transport: 'stdio', command: 'x' } },
        })
      },
    }),
  }).snapshot()
  assert.equal(snapshot.servers.length, 2)
  assert.ok(snapshot.warnings.some((warning) => warning.includes('rea')), snapshot.warnings.join('; '))
})

test('the endpoint reads as a command line for stdio and a URL for http', () => {
  const snapshot = service({
    loader: () => ({
      entries: function* () {
        yield mcpEntry()
        yield {
          options: {
            id: 'web',
            name: '@deepseek-ai/dsh-mcp-client',
            config: { serverName: 'web', transport: 'streamable-http', url: 'https://web.example/mcp' },
          },
          fiber: { state: 2 },
        }
      },
    }),
  }).snapshot()

  const rea = snapshot.servers.find((server) => server.serverName === 'rea')
  const web = snapshot.servers.find((server) => server.serverName === 'web')
  assert.equal(rea.endpoint, 'C:/node/node.exe rea.mjs mcp')
  assert.equal(web.endpoint, 'https://web.example/mcp')
})

test('tools are grouped by the mcp__<server>__ prefix', () => {
  const visible = new Map([
    ['mcp__rea__search', { description: 'Search', parameters: { type: 'object' } }],
    ['mcp__rea__read', { description: 'Read', parameters: { type: 'object' } }],
    ['mcp__other__ping', { description: 'Ping', parameters: {} }],
    ['read_file', { description: 'not an mcp tool', parameters: {} }],
  ])
  const snapshot = service({
    loader: () => ({ entries: () => [mcpEntry()] }),
    tools: () => ({ view: () => ({ visible }) }),
  }).snapshot()

  const rea = snapshot.servers[0]
  assert.deepEqual(rea.tools.map((tool) => tool.rawName), ['read', 'search'])
  assert.equal(rea.tools[0].name, 'mcp__rea__read')
  assert.equal(rea.toolPrefix, 'mcp__rea__')
})

test('a failing tool registry degrades to an empty tool set', () => {
  const snapshot = service({
    loader: () => ({ entries: () => [mcpEntry()] }),
    tools: () => {
      throw new Error('registry unavailable')
    },
  }).snapshot()
  assert.equal(snapshot.servers.length, 1)
  assert.deepEqual(snapshot.servers[0].tools, [])
})

test('connection state follows the fiber and the registered tools', () => {
  const visible = new Map([['mcp__rea__search', { description: '', parameters: {} }]])

  const connected = service({
    loader: () => ({ entries: () => [mcpEntry()] }),
    tools: () => ({ view: () => ({ visible }) }),
  }).snapshot().servers[0]
  assert.equal(connected.state, CONNECTION_STATES.connected)

  const emptyButActive = service({
    loader: () => ({ entries: () => [mcpEntry()] }),
  }).snapshot().servers[0]
  assert.equal(emptyButActive.state, CONNECTION_STATES.connected)
  assert.match(emptyButActive.detail, /未声明任何工具/)

  const failed = service({
    loader: () => ({
      entries: () => [mcpEntry({ fiber: { state: 3, error: new Error('ECONNREFUSED') } })],
    }),
  }).snapshot().servers[0]
  assert.equal(failed.state, CONNECTION_STATES.error)
  assert.match(failed.detail, /ECONNREFUSED/)

  const disabled = service({
    loader: () => ({
      entries: () => [
        mcpEntry({
          options: {
            id: 'rea-mcp',
            name: '@deepseek-ai/dsh-mcp-client',
            disabled: true,
            config: { serverName: 'rea', transport: 'stdio', command: 'node' },
          },
        }),
      ],
    }),
  }).snapshot().servers[0]
  assert.equal(disabled.state, CONNECTION_STATES.inactive)
  assert.equal(disabled.disabled, true)
})

test('counts summarise the inventory', () => {
  const snapshot = service({
    loader: () => ({
      entries: function* () {
        yield mcpEntry()
        yield {
          options: { id: 'bad', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'bad', transport: 'stdio', command: 'x' } },
          fiber: { state: 3, error: new Error('boom') },
        }
      },
    }),
  }).snapshot()
  assert.equal(snapshot.counts.total, 2)
  assert.equal(snapshot.counts.connected, 1)
  assert.equal(snapshot.counts.error, 1)
})

test('a row without serverName is skipped with a warning', () => {
  const snapshot = service({
    loader: () => ({
      entries: () => [
        { options: { id: 'broken', name: '@deepseek-ai/dsh-mcp-client', config: {} }, fiber: { state: 2 } },
      ],
    }),
  }).snapshot()
  assert.equal(snapshot.servers.length, 0)
  assert.ok(snapshot.warnings.some((warning) => warning.includes('broken')))
})

test('jsonSafe strips functions and keeps the rest', () => {
  const value = jsonSafe({ a: 1, b: 'x', fn() {}, c: [1, 2], d: { e: true } })
  assert.deepEqual(value, { a: 1, b: 'x', c: [1, 2], d: { e: true } })
})

test('a missing loader produces an empty inventory rather than throwing', () => {
  const snapshot = service({ loader: () => undefined }).snapshot()
  assert.deepEqual(snapshot.servers, [])
  assert.equal(snapshot.counts.total, 0)
})
