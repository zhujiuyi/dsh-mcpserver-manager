/**
 * @zhujiuyi/dsh-mcp-manager — the MCP server inventory.
 *
 * Reads the profile's composed Loader entries, projects every
 * `@deepseek-ai/dsh-mcp-client` row into a `ManagedServer`, and decorates it
 * with the live tool set and connection state observed through `ctx.tools` and
 * the row's own fiber.
 *
 * Why read the Loader tree rather than the patch file:
 *   - the patch is only one of several layers (bundles, home patch, `--patch`
 *     overlays), so a file read would miss servers the user configured
 *     elsewhere and would misreport the effective value of an overridden field;
 *   - every row already carries its resolved `config`, so no re-parsing and no
 *     re-implementing of the composition rules is needed.
 *
 * The patch file is read only when *writing*, where it is the authoritative
 * document being edited.
 */

import { MCP_CLIENT_PACKAGE, messageOf } from './parse.mjs'

/**
 * The connection states a managed server can be in.
 *
 * These are derived, not reported by the client plugin: the MCP client does
 * not expose a status service, so the state is inferred from what the
 * registry and the fiber can show. Each state therefore means exactly what its
 * derivation says, and `detail` carries the evidence.
 */
export const CONNECTION_STATES = Object.freeze({
  connected: 'connected',
  inactive: 'inactive',
  error: 'error',
  unknown: 'unknown',
})

/**
 * @typedef {object} ManagedTool
 * @property {string} name        Public model-facing name (`mcp__<server>__<tool>`).
 * @property {string} rawName     Name without the namespace prefix.
 * @property {string} description
 * @property {object} schema      The declared parameter schema, JSON-safe.
 */

/**
 * @typedef {object} ManagedServer
 * @property {string} id            Loader row id.
 * @property {string} serverName    `serverName` from the client Config.
 * @property {string} transport     `stdio` or `streamable-http`.
 * @property {string} rowName       The plugin package the row loads.
 * @property {string} endpoint      Command line or URL, for display.
 * @property {boolean} disabled     Whether the row is disabled in the patch.
 * @property {string} state         One of CONNECTION_STATES.
 * @property {string} detail        Human-readable evidence for `state`.
 * @property {string[]} warnings    Non-fatal configuration observations.
 * @property {ManagedTool[]} tools  Live tools registered under this namespace.
 * @property {string} toolPrefix    `mcp__<serverName>__`.
 * @property {object} config        The effective client Config, detached.
 */

/**
 * Build the inventory service.
 *
 * @param {object} options
 * @param {() => any} options.loader            The Loader service.
 * @param {() => any} options.tools             The tool registry service.
 * @param {() => any} options.configEditor      Optional; enables in-place edits.
 * @param {() => string} options.patchPath      The profile patch this plugin writes.
 * @param {(message: string) => void} [options.warn]
 */
export function createInventoryService(options) {
  const { loader, tools, patchPath, warn } = options

  /**
   * Every addressable Loader entry, as the Loader itself reports them.
   *
   * `loader.entries()` is a **generator** in the real Loader (it walks the tree
   * depth-first), not an array. Guarding with `Array.isArray` therefore threw
   * away every entry and produced an empty inventory, so anything iterable is
   * spread instead.
   *
   * @returns {any[]}
   */
  function allEntries() {
    try {
      const service = loader()
      if (service === undefined || service === null) return []
      const list = typeof service.entries === 'function' ? service.entries() : []
      if (list === null || list === undefined) return []
      if (Array.isArray(list)) return [...list]
      if (typeof list[Symbol.iterator] === 'function') return [...list]
      return []
    } catch (error) {
      warn?.(`loader.entries() failed: ${messageOf(error)}`)
      return []
    }
  }

  /**
   * Read one row's resolved config, tolerating any shape the loader uses.
   * @param {any} entry
   * @returns {Record<string, any>}
   */
  function configOf(entry) {
    const raw = entry?.options?.config
    if (raw === null || raw === undefined || typeof raw !== 'object') return {}
    return { ...raw }
  }

  /**
   * Whether a Loader entry is one of this plugin's managed MCP rows.
   * @param {any} entry
   * @returns {boolean}
   */
  function isMcpEntry(entry) {
    const rowName = entry?.options?.name
    if (typeof rowName !== 'string') return false
    // The row may name the package, the short plugin name, or a relative path
    // that resolves to it. Accept the documented spellings and anything whose
    // basename is the package.
    return rowName === MCP_CLIENT_PACKAGE || rowName === 'mcp-client' || rowName.endsWith('/dsh-mcp-client')
  }

  /**
   * Project the live tool registry into `mcp__<server>__` groups.
   * @returns {Map<string, ManagedTool[]>}
   */
  function toolsByServer() {
    /** @type {Map<string, ManagedTool[]>} */
    const grouped = new Map()
    try {
      const service = tools()
      if (service === undefined || service === null) return grouped
      const view = typeof service.view === 'function' ? service.view(undefined) : undefined
      const visible = view?.visible
      if (!(visible instanceof Map)) return grouped
      for (const [publicName, definition] of visible) {
        const match = /^mcp__(.+?)__(.+)$/.exec(publicName)
        if (match === null) continue
        const [, serverName, rawName] = match
        const bucket = grouped.get(serverName) ?? []
        bucket.push({
          name: publicName,
          rawName,
          description: typeof definition?.description === 'string' ? definition.description : '',
          schema: jsonSafe(definition?.parameters ?? {}),
        })
        grouped.set(serverName, bucket)
      }
    } catch (error) {
      warn?.(`tools.view() failed: ${messageOf(error)}`)
    }
    for (const list of grouped.values()) list.sort((a, b) => a.rawName.localeCompare(b.rawName))
    return grouped
  }

  /**
   * Derive a connection state for one row.
   *
   * The MCP client exposes no status service, so the state is read off the
   * fiber: an active fiber whose tools are registered is connected, a disabled
   * or inactive row is inactive, an active row that registered no tools may
   * still be connected without a tools capability, and an errored fiber is an
   * error. `detail` says which rule applied so the page never claims more than
   * was actually observed.
   *
   * @param {any} entry
   * @param {ManagedTool[]} registeredTools
   * @param {boolean} disabled
   * @returns {{ state: string, detail: string }}
   */
  function deriveState(entry, registeredTools, disabled) {
    if (disabled) {
      return { state: CONNECTION_STATES.inactive, detail: '该条目在配置中被停用（disabled）' }
    }

    const fiber = entry?.fiber
    if (fiber === undefined || fiber === null) {
      return { state: CONNECTION_STATES.inactive, detail: '该条目尚未加载' }
    }

    // Cordis fiber states: 'loading' | 'active' | 'failed' | 'disposed' (the
    // loader stores the numeric form in `state`, with string names available).
    const stateName = stringState(fiber)
    if (stateName === 'failed') {
      const reason = fiber?.error?.message ?? '插件激活失败'
      return { state: CONNECTION_STATES.error, detail: String(reason) }
    }
    if (stateName === 'disposed') {
      return { state: CONNECTION_STATES.inactive, detail: '该条目已卸载' }
    }
    if (registeredTools.length > 0) {
      return {
        state: CONNECTION_STATES.connected,
        detail: `已注册 ${registeredTools.length} 个工具`,
      }
    }
    if (stateName === 'active') {
      // The client connects even when the server advertises no tools, so this
      // is a connected-but-empty server rather than a failure.
      return {
        state: CONNECTION_STATES.connected,
        detail: '已连接，但该服务未声明任何工具',
      }
    }
    return { state: CONNECTION_STATES.unknown, detail: `连接状态未知（fiber: ${stateName}）` }
  }

  /**
   * Build the full inventory.
   * @returns {{ patchPath: string, servers: ManagedServer[], warnings: string[] }}
   */
  function snapshot() {
    /** @type {string[]} */
    const warnings = []
    const byServer = toolsByServer()
    /** @type {ManagedServer[]} */
    const servers = []
    /** @type {Map<string, string>} */
    const seen = new Map()

    for (const entry of allEntries()) {
      if (!isMcpEntry(entry)) continue
      const config = configOf(entry)
      const serverName = typeof config.serverName === 'string' ? config.serverName : ''
      if (serverName === '') {
        warnings.push(`条目 ${String(entry?.options?.id)} 没有 serverName，已跳过`)
        continue
      }

      const previous = seen.get(serverName)
      if (previous !== undefined) {
        warnings.push(
          `serverName “${serverName}” 被多个条目使用（${previous} 与 ${String(entry?.options?.id)}）；后加载的条目会失败`,
        )
      }
      seen.set(serverName, String(entry?.options?.id))

      const disabled = isDisabled(entry)
      const registered = byServer.get(serverName) ?? []
      const { state, detail } = deriveState(entry, registered, disabled)

      servers.push({
        id: String(entry?.options?.id ?? ''),
        serverName,
        transport: String(config.transport ?? 'stdio'),
        rowName: String(entry?.options?.name ?? MCP_CLIENT_PACKAGE),
        endpoint: endpointOf(config),
        disabled,
        state,
        detail,
        warnings: configWarnings(serverName, config),
        tools: registered,
        toolPrefix: `mcp__${serverName}__`,
        config: jsonSafe(config),
      })
    }

    servers.sort((a, b) => a.serverName.localeCompare(b.serverName))
    return {
      patchPath: safePatchPath(),
      servers,
      warnings,
      counts: {
        total: servers.length,
        connected: servers.filter((s) => s.state === CONNECTION_STATES.connected).length,
        inactive: servers.filter((s) => s.state === CONNECTION_STATES.inactive).length,
        error: servers.filter((s) => s.state === CONNECTION_STATES.error).length,
        tools: servers.reduce((sum, s) => sum + s.tools.length, 0),
      },
      generatedAt: Date.now(),
    }
  }

  /**
   * @returns {string}
   */
  function safePatchPath() {
    try {
      return String(patchPath())
    } catch {
      return ''
    }
  }

  return { snapshot, allEntries, isMcpEntry, configOf }
}

/**
 * Whether the row is disabled, reading both the boolean and the `!!js` form.
 * @param {any} entry
 * @returns {boolean}
 */
function isDisabled(entry) {
  const flag = entry?.options?.disabled
  if (flag === undefined || flag === null) return false
  if (typeof flag === 'boolean') return flag
  if (typeof flag === 'object' && typeof flag.__jsExpr === 'string') {
    // An expression cannot be evaluated here without running user code; the
    // conservative reading is "disabled only when it is literally true".
    return flag.__jsExpr.trim() === 'true'
  }
  return Boolean(flag)
}

/**
 * Render the endpoint a server connects to.
 * @param {Record<string, any>} config
 * @returns {string}
 */
function endpointOf(config) {
  if (config.transport === 'stdio' || config.transport === undefined) {
    if (typeof config.command !== 'string') return ''
    const args = Array.isArray(config.args) ? config.args.map(String) : []
    return [config.command, ...args].join(' ')
  }
  return typeof config.url === 'string' ? config.url : ''
}

/**
 * Configuration observations that do not stop the server from running.
 * @param {string} serverName
 * @param {Record<string, any>} config
 * @returns {string[]}
 */
function configWarnings(serverName, config) {
  /** @type {string[]} */
  const out = []
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    out.push(`serverName “${serverName}” 不符合 [A-Za-z0-9_-]{1,32}，该条目可能无法加载`)
  }
  if (config.transport === 'stdio' && typeof config.command !== 'string') {
    out.push('stdio 传输缺少 command')
  }
  if (config.transport === 'streamable-http' && typeof config.url !== 'string') {
    out.push('streamable-http 传输缺少 url')
  }
  if (config.transport !== 'stdio' && config.transport !== 'streamable-http') {
    out.push(`transport “${String(config.transport)}” 不是 stdio 或 streamable-http`)
  }
  return out
}

/**
 * Map a fiber's numeric or string state onto a name.
 * @param {any} fiber
 * @returns {string}
 */
function stringState(fiber) {
  const state = fiber?.state
  if (typeof state === 'string') return state
  // Cordis FiberState: 0 pending, 1 loading, 2 active, 3 failed, 4 disposed.
  switch (state) {
    case 0:
      return 'pending'
    case 1:
      return 'loading'
    case 2:
      return 'active'
    case 3:
      return 'failed'
    case 4:
      return 'disposed'
    default:
      return 'unknown'
  }
}

/**
 * Detach a value into lossless JSON, so a response never carries functions or
 * `!!js` nodes the browser cannot represent.
 * @param {unknown} value
 * @returns {any}
 */
export function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, inner) => {
      if (typeof inner === 'function') return undefined
      if (typeof inner === 'bigint') return String(inner)
      return inner
    }) ?? 'null',
  )
}
