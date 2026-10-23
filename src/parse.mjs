/**
 * @zhujiuyi/dsh-mcp-manager — MCP configuration parsing and normalization.
 *
 * Two import dialects are accepted, and both normalize to one canonical
 * `McpServerDraft` that the rest of the plugin reasons about:
 *
 *   1. **dsh patch string** — the YAML-ish block a user copies out of this very
 *      patch file, either the loader `- insert:` form or the shorthand
 *      `@mcp <name>` / `[mcp.<name>]` form. Several servers may appear at once.
 *   2. **Claude Code / Cursor `mcpServers` JSON** — `{"mcpServers": {...}}` or a
 *      bare `{ "<name>": {...} }` map. Several servers may appear at once.
 *
 * The canonical draft mirrors the `@deepseek-ai/dsh-mcp-client` Config schema
 * exactly, so `toDshEntry()` output can be written into `cordis.patch.yml` with
 * no further translation:
 *
 *   transport: 'stdio'           -> serverName, command, args, env, cwd
 *   transport: 'streamable-http' -> serverName, url, headers
 *
 * Everything is a pure function with no I/O, so the whole dialect surface is
 * unit-testable without a Harness running.
 */

/** Transports the dsh MCP client accepts; `sse` is deliberately not one. */
export const TRANSPORTS = Object.freeze(['stdio', 'streamable-http'])

/** `serverName` pattern enforced by the client's Config schema. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Default per-call timeout the client applies when a draft omits one. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000

/** The package name every managed row must carry. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/**
 * Raised for input the user must correct; `message` is shown verbatim in the
 * dialog's error strip, so it names the offending field and value.
 */
export class McpConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'McpConfigError'
  }
}

/**
 * @typedef {object} McpServerDraft
 * @property {string} serverName              Namespace for `mcp__<name>__<tool>`.
 * @property {'stdio' | 'streamable-http'} transport
 * @property {string} [command]               stdio only.
 * @property {string[]} [args]                stdio only.
 * @property {Record<string, string>} [env]   stdio only.
 * @property {string} [cwd]                   stdio only; empty means inherit.
 * @property {string} [url]                   streamable-http only.
 * @property {Record<string, string>} [headers] streamable-http only.
 * @property {number} [toolCallTimeoutMs]
 * @property {boolean} [failOnStartupError]
 * @property {string} [id]                    Existing loader row id, when editing.
 */

// ── small helpers ───────────────────────────────────────────────────────────

/**
 * Strip one matching pair of surrounding quotes.
 * @param {string} value
 * @returns {string}
 */
function stripQuotes(value) {
  const text = String(value ?? '').trim()
  if (text.length > 1) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1)
    }
  }
  return text
}

/**
 * Split a shell-ish argument string, honouring single and double quotes.
 * @param {string} value
 * @returns {string[]}
 */
function tokenize(value) {
  /** @type {string[]} */
  const out = []
  let current = ''
  let quote = null
  for (const ch of String(value ?? '')) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current !== '') {
        out.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (quote !== null) throw new McpConfigError('参数中的引号未闭合')
  if (current !== '') out.push(current)
  return out
}

/**
 * Parse an inline `KEY=VALUE, KEY=VALUE` list (the `env:` / `headers:` form
 * used by the dsh shorthand).
 * @param {string} value
 * @param {number} line
 * @returns {Record<string, string>}
 */
function parseInlinePairs(value, line) {
  /** @type {Record<string, string>} */
  const out = {}
  const parts = String(value ?? '')
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
  for (const part of parts) {
    const at = part.indexOf('=')
    if (at < 1) throw new McpConfigError(`第 ${line} 行：需要使用 KEY=VALUE 格式`)
    out[part.slice(0, at).trim()] = stripQuotes(part.slice(at + 1))
  }
  return out
}

/**
 * Whether a value is a `!!js` expression node handed over by the Loader.
 *
 * The Loader keeps `!!js` expressions unevaluated in a row's raw config as a
 * `{ __jsExpr: '<source>' }` wrapper. That wrapper is what makes the round trip
 * lossless: a config this plugin does not understand must be handed back
 * verbatim, never stringified (which would silently write `[object Object]`).
 *
 * @param {unknown} value
 * @returns {value is { __jsExpr: string }}
 */
export function isJsExpr(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (/** @type {any} */ (value).__jsExpr) === 'string'
  )
}

/**
 * Coerce an arbitrary object into a `Record<string, string>`, dropping nothing
 * but stringifying plain values. A `!!js` expression is preserved as its
 * wrapper so the value survives a round trip unchanged.
 * @param {unknown} value
 * @returns {Record<string, string | { __jsExpr: string }>}
 */
function toStringMap(value) {
  /** @type {Record<string, string | { __jsExpr: string }>} */
  const out = {}
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, raw] of Object.entries(value)) {
      out[key] = isJsExpr(raw) ? { __jsExpr: raw.__jsExpr } : String(raw)
    }
  }
  return out
}

/**
 * Read a scalar that may be a plain string or a `!!js` expression.
 * @param {unknown} value
 * @returns {string | { __jsExpr: string } | null}
 */
function scalarOrExpr(value) {
  if (isJsExpr(value)) return { __jsExpr: value.__jsExpr }
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

/**
 * Map every accepted transport spelling onto the client's two real values.
 * `sse` is rejected here rather than silently downgraded, because the dsh
 * client has no SSE transport and a silent rewrite would be a lie.
 * @param {unknown} value
 * @returns {'stdio' | 'streamable-http'}
 */
export function normalizeTransport(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '' || text === 'stdio') return 'stdio'
  if (
    text === 'streamable-http' ||
    text === 'streamablehttp' ||
    text === 'streamable_http' ||
    text === 'http' ||
    text === 'https'
  ) {
    return 'streamable-http'
  }
  if (text === 'sse') {
    throw new McpConfigError(
      'dsh 的 MCP 客户端不支持 SSE 传输，请改用 streamable-http（若该服务同时提供 /mcp 端点）',
    )
  }
  throw new McpConfigError(`不受支持的传输方式 “${String(value)}”，可用：stdio、streamable-http`)
}

/**
 * Validate and finish one draft. Every parser funnels through here so all
 * import paths share exactly one rule set.
 * @param {Partial<McpServerDraft>} draft
 * @returns {McpServerDraft}
 */
export function finalizeDraft(draft) {
  const serverName = String(draft.serverName ?? '').trim()
  if (serverName === '') {
    throw new McpConfigError('缺少服务名称（serverName）')
  }
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new McpConfigError(
      `服务名称 “${serverName}” 不合法：只允许字母、数字、下划线和短横线，长度 1–32`,
    )
  }

  const transport = normalizeTransport(draft.transport)
  /** @type {McpServerDraft} */
  const out = { serverName, transport }
  // The field is carried only when the caller stated it. A draft that never
  // mentioned it stays silent, so a newly added server is written as short as
  // the documentation's example; a row that already carries an explicit value
  // (even the default one) keeps it through an edit.

  if (transport === 'stdio') {
    const command = scalarOrExpr(draft.command)
    if (command === null) {
      throw new McpConfigError(`服务 “${serverName}” 缺少 command（stdio 需要启动命令）`)
    }
    out.command = command
    out.args = Array.isArray(draft.args) ? draft.args.map((arg) => (isJsExpr(arg) ? { __jsExpr: arg.__jsExpr } : String(arg))) : []
    const env = toStringMap(draft.env)
    if (Object.keys(env).length > 0) out.env = env
    const cwd = scalarOrExpr(draft.cwd)
    if (cwd !== null) out.cwd = cwd
  } else {
    const url = scalarOrExpr(draft.url)
    if (url === null) {
      throw new McpConfigError(`服务 “${serverName}” 缺少 url（streamable-http 需要端点地址）`)
    }
    // A `!!js` URL is an expression; its value is only known at load time, so
    // it is accepted verbatim rather than validated here.
    if (typeof url === 'string') {
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        throw new McpConfigError(`服务 “${serverName}” 的 url 格式不正确：${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new McpConfigError(`服务 “${serverName}” 的 url 仅支持 http(s)：${url}`)
      }
    }
    out.url = url
    const headers = toStringMap(draft.headers)
    if (Object.keys(headers).length > 0) out.headers = headers
  }

  const timeout = Number(draft.toolCallTimeoutMs)
  if (Number.isFinite(timeout) && timeout > 0) out.toolCallTimeoutMs = timeout
  if (draft.failOnStartupError === true) out.failOnStartupError = true
  if (typeof draft.id === 'string' && draft.id !== '') out.id = draft.id
  return out
}

// ── dialect 1: the dsh patch / shorthand string ─────────────────────────────

/**
 * Parse one dsh-dialect string. Accepts three shapes, in any mix:
 *
 *   - the loader form the patch file itself uses:
 *       - id: mcp-dbx
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config:
 *           serverName: dbx
 *           transport: stdio
 *           command: 'C:\\...\\dbx-mcp.exe'
 *   - the shorthand form:
 *       @mcp dbx
 *       transport: stdio
 *       command: 'C:\\...\\dbx-mcp.exe'
 *   - the INI-ish form:
 *       [mcp.dbx]
 *       transport: stdio
 *
 * The first form is the important one: users copy rows straight out of
 * `cordis.patch.yml`, and that text is YAML with `!!js` tags and nested maps.
 * A hand-rolled line parser would mangle it, so when the text contains a
 * `- id:` / `- insert:` structure the real YAML parser is used instead.
 *
 * @param {string} text
 * @returns {McpServerDraft[]}
 */
export function parseDshString(text) {
  const source = String(text ?? '').trim()
  if (source === '') throw new McpConfigError('配置字符串为空')

  if (looksLikePatchYaml(source)) return parsePatchYaml(source)
  return parseShorthand(source)
}

/**
 * Decide whether the text is patch YAML (structural) or the line shorthand.
 * Patch YAML always opens with a `-` sequence item whose first key is `id`,
 * `insert`, or `name`; the shorthand opens with `@mcp`, `[mcp.x]`, or `key:`.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikePatchYaml(text) {
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    return /^-\s/.test(line)
  }
  return false
}

/**
 * Parse a patch-shaped YAML document using the YAML parser the Host already
 * depends on. `!!js` tags are accepted and preserved as strings, because a
 * configuration being imported from text cannot safely evaluate expressions —
 * the value is kept verbatim for the user to edit.
 * @param {string} text
 * @returns {McpServerDraft[]}
 */
function parsePatchYaml(text) {
  let document
  try {
    document = parseYamlDocument(text)
  } catch (error) {
    throw new McpConfigError(`YAML 解析失败：${messageOf(error)}`)
  }

  if (!Array.isArray(document)) {
    throw new McpConfigError('dsh 配置片段应为顶层数组（以 - 开头），示例：- id: mcp-xxx')
  }

  /** @type {McpServerDraft[]} */
  const drafts = []
  for (const row of document) {
    if (row === null || typeof row !== 'object') continue
    // `- insert: [ ... ]` wraps one or more rows.
    if (Array.isArray(row.insert)) {
      for (const inner of row.insert) collectRow(inner, drafts)
      continue
    }
    collectRow(row, drafts)
  }

  if (drafts.length === 0) {
    throw new McpConfigError(
      '未在配置片段中找到 MCP 服务。需要包含 config.serverName，且 name 为 @deepseek-ai/dsh-mcp-client',
    )
  }
  return drafts
}

/**
 * Turn one YAML row into a draft when it is an MCP client row.
 * @param {unknown} row
 * @param {McpServerDraft[]} out
 */
function collectRow(row, out) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return
  const name = typeof row.name === 'string' ? row.name.trim() : ''
  const config = row.config !== null && typeof row.config === 'object' ? row.config : {}

  // A row without an explicit name is still accepted when its config looks
  // like an MCP client config; users copy fragments out of context.
  const isMcpRow = name === '' || name === MCP_CLIENT_PACKAGE || name === 'mcp-client'
  if (!isMcpRow) {
    throw new McpConfigError(
      `配置片段中的 name “${name}” 不是 MCP 客户端；只能导入 @deepseek-ai/dsh-mcp-client 的服务行`,
    )
  }
  if (config.serverName === undefined && config.command === undefined && config.url === undefined) {
    return
  }

  out.push(
    finalizeDraft({
      id: typeof row.id === 'string' ? row.id : undefined,
      serverName: config.serverName,
      transport: config.transport,
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      url: config.url,
      headers: config.headers,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      failOnStartupError: config.failOnStartupError,
    }),
  )
}

/**
 * The lightweight line dialect (`@mcp name` / `[mcp.name]` / `key: value`).
 * @param {string} text
 * @returns {McpServerDraft[]}
 */
function parseShorthand(text) {
  /** @type {Partial<McpServerDraft>[]} */
  const collected = []
  /** @type {Partial<McpServerDraft> | null} */
  let current = null

  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const lineNumber = index + 1
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return

    const header = line.match(/^@mcp\s+(.+)$/i)
    if (header !== null) {
      if (current !== null) collected.push(current)
      current = { serverName: stripQuotes(header[1]) }
      return
    }

    const section = line.match(/^\[mcp\.([^\]]+)\]$/i)
    if (section !== null) {
      if (current !== null) collected.push(current)
      current = { serverName: section[1].trim() }
      return
    }

    if (current === null) current = { serverName: '' }

    const field = line.match(/^([A-Za-z][\w.-]*)\s*:\s*(.*)$/)
    if (field === null) {
      throw new McpConfigError(`第 ${lineNumber} 行：无法解析 “${line}”`)
    }

    const rawKey = field[1]
    const key = rawKey.toLowerCase()
    const value = field[2].trim()

    const nested = rawKey.match(/^(env|headers)\.(.+)$/i)
    if (nested !== null) {
      const bucket = nested[1].toLowerCase()
      const existing = (current[bucket] ?? {})
      existing[nested[2]] = stripQuotes(value)
      current[bucket] = existing
      return
    }

    switch (key) {
      case 'servername':
      case 'name':
      case 'id':
        current.serverName = stripQuotes(value)
        return
      case 'transport':
      case 'type':
        current.transport = stripQuotes(value)
        return
      case 'command':
        current.command = stripQuotes(value)
        return
      case 'args':
        current.args = tokenize(value)
        return
      case 'cwd':
        current.cwd = stripQuotes(value)
        return
      case 'url':
      case 'endpoint':
        current.url = stripQuotes(value)
        return
      case 'env':
        current.env = { ...(current.env ?? {}), ...parseInlinePairs(value, lineNumber) }
        return
      case 'headers':
        current.headers = { ...(current.headers ?? {}), ...parseInlinePairs(value, lineNumber) }
        return
      case 'toolcalltimeoutms': {
        const ms = Number(stripQuotes(value))
        if (!Number.isFinite(ms)) {
          throw new McpConfigError(`第 ${lineNumber} 行：toolCallTimeoutMs 需要数字`)
        }
        current.toolCallTimeoutMs = ms
        return
      }
      default:
        throw new McpConfigError(`第 ${lineNumber} 行：无法识别字段 “${rawKey}”`)
    }
  })

  if (current !== null) collected.push(current)
  if (collected.length === 0) throw new McpConfigError('未识别到服务配置，请检查格式')

  return collected.map(finalizeDraft)
}

// ── dialect 2: Claude Code / Cursor mcpServers JSON ─────────────────────────

/**
 * Parse a `mcpServers` JSON block.
 *
 * Accepted roots, in order of preference:
 *   - `{ "mcpServers": { ... } }`  (Claude Desktop / Claude Code / Cursor)
 *   - `{ "servers": { ... } }`     (older Cursor)
 *   - `{ "<name>": { "command": ... } }` (a bare map)
 *   - a single entry carrying its own `name`
 *
 * @param {string} text
 * @returns {McpServerDraft[]}
 */
export function parseClaudeJson(text) {
  const source = String(text ?? '').trim()
  if (source === '') throw new McpConfigError('JSON 内容为空')

  let root
  try {
    root = JSON.parse(source)
  } catch (error) {
    throw new McpConfigError(`JSON 解析失败：${messageOf(error)}`)
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new McpConfigError('JSON 顶层需要是对象')
  }

  /** @type {[string, unknown][] | null} */
  let entries = null
  if (isPlainObject(root.mcpServers)) {
    entries = Object.entries(root.mcpServers)
  } else if (isPlainObject(root.servers)) {
    entries = Object.entries(root.servers)
  } else if (typeof root.name === 'string' && (root.command || root.url || root.type)) {
    entries = [[root.name, root]]
  } else {
    const values = Object.values(root)
    if (
      values.length > 0 &&
      values.every((value) => isPlainObject(value) && (value.command !== undefined || value.url !== undefined))
    ) {
      entries = Object.entries(root)
    }
  }

  if (entries === null || entries.length === 0) {
    throw new McpConfigError(
      '未找到 mcpServers 字段。示例：{"mcpServers": {"name": {"command": "..."}}}',
    )
  }

  return entries.map(([name, raw]) => {
    if (!isPlainObject(raw)) {
      throw new McpConfigError(`服务 “${name}” 的配置不是对象`)
    }
    const transport =
      raw.type !== undefined || raw.transport !== undefined
        ? normalizeTransport(raw.type ?? raw.transport)
        : raw.url !== undefined
          ? 'streamable-http'
          : 'stdio'

    const args = Array.isArray(raw.args)
      ? raw.args.map(String)
      : typeof raw.args === 'string'
        ? tokenize(raw.args)
        : []

    return finalizeDraft({
      serverName: name,
      transport,
      command: typeof raw.command === 'string' ? raw.command : '',
      args,
      env: raw.env,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      url: typeof raw.url === 'string' ? raw.url : '',
      headers: raw.headers,
    })
  })
}

/**
 * Auto-detect which dialect a pasted string is.
 * @param {string} text
 * @returns {'dsh' | 'json'}
 */
export function detectDialect(text) {
  const source = String(text ?? '').trim()
  if (source === '') return 'dsh'
  return /^[[{]/.test(source) ? 'json' : 'dsh'
}

/**
 * Parse a pasted string, choosing the dialect by shape.
 * @param {string} text
 * @returns {{ dialect: 'dsh' | 'json', drafts: McpServerDraft[] }}
 */
export function parseAny(text) {
  const dialect = detectDialect(text)
  return { dialect, drafts: dialect === 'json' ? parseClaudeJson(text) : parseDshString(text) }
}

// ── output: draft -> the patch row this plugin writes ───────────────────────

/**
 * Render one draft as the loader row inserted into `cordis.patch.yml`.
 *
 * The row is shaped exactly like the documented configuration, so a future
 * reader cannot tell it was written by this plugin rather than by hand.
 *
 * @param {McpServerDraft} draft
 * @param {{ id?: string }} [options]
 * @returns {Record<string, unknown>}
 */
export function toDshEntry(draft, options = {}) {
  const server = finalizeDraft(draft)
  /** @type {Record<string, unknown>} */
  const config = {
    serverName: server.serverName,
    transport: server.transport,
  }

  // `!!js` values keep their wrapper all the way to the patch writer, which
  // renders them back as `!!js <source>`. Dropping one here would silently
  // break a working configuration the user never meant to touch.
  const put = (key, value) => {
    config[key] = isJsExpr(value) ? { __jsExpr: value.__jsExpr } : value
  }

  if (server.transport === 'stdio') {
    put('command', server.command)
    if ((server.args ?? []).length > 0) config.args = [...server.args]
    if (server.env !== undefined && Object.keys(server.env).length > 0) {
      config.env = { ...server.env }
    }
    if (server.cwd !== undefined) put('cwd', server.cwd)
  } else {
    put('url', server.url)
    if (server.headers !== undefined && Object.keys(server.headers).length > 0) {
      config.headers = { ...server.headers }
    }
  }

  // `toolCallTimeoutMs` is written whenever the caller supplied it, including
  // when it equals the client's default. Omitting a default that the user (or
  // an existing row) stated would make "open the editor and save" silently drop
  // a field from a configuration the user never asked to change. A draft that
  // never mentioned the field leaves it out, so a freshly added server stays
  // as short as the documentation's example.
  if (server.toolCallTimeoutMs !== undefined) {
    config.toolCallTimeoutMs = server.toolCallTimeoutMs
  }
  if (server.failOnStartupError === true) config.failOnStartupError = true

  return {
    id: options.id ?? server.id ?? suggestRowId(server.serverName),
    name: MCP_CLIENT_PACKAGE,
    config,
  }
}

/**
 * Derive a stable row id from a server name: `dbx` -> `mcp-dbx`.
 * The loader treats ids as opaque, but a predictable shape keeps the patch
 * readable and matches how rows are documented.
 * @param {string} serverName
 * @returns {string}
 */
export function suggestRowId(serverName) {
  const slug = String(serverName ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `mcp-${slug === '' ? 'server' : slug}`
}

/**
 * Render a draft back into the dsh shorthand for the detail page's read-only
 * preview. This is display text only — never parsed back in.
 * @param {McpServerDraft} draft
 * @returns {string}
 */
export function toDshPreview(draft) {
  const server = finalizeDraft(draft)
  const lines = [`@mcp ${server.serverName}`, `transport: ${server.transport}`]
  /** Render a value that may be an expression. */
  const show = (value) => (isJsExpr(value) ? `!!js ${value.__jsExpr}` : String(value))
  if (server.transport === 'stdio') {
    lines.push(`command: ${show(server.command)}`)
    if ((server.args ?? []).length > 0) {
      lines.push(`args: ${server.args.map(quoteArg).join(' ')}`)
    }
    const env = Object.entries(server.env ?? {})
    if (env.length > 0) lines.push(`env: ${env.map(([k, v]) => `${k}=${show(v)}`).join(', ')}`)
    if (server.cwd !== undefined) lines.push(`cwd: ${show(server.cwd)}`)
  } else {
    lines.push(`url: ${show(server.url)}`)
    const headers = Object.entries(server.headers ?? {})
    if (headers.length > 0) {
      lines.push(`headers: ${headers.map(([k, v]) => `${k}=${show(v)}`).join(', ')}`)
    }
  }
  return lines.join('\n')
}

/**
 * Render a draft as a Claude Code `mcpServers` block, for users who want the
 * configuration in the other direction.
 * @param {McpServerDraft} draft
 * @returns {string}
 */
export function toClaudeJsonPreview(draft) {
  const server = finalizeDraft(draft)
  /** @type {Record<string, unknown>} */
  const entry = {}
  if (server.transport === 'stdio') {
    entry.command = server.command
    if ((server.args ?? []).length > 0) entry.args = [...server.args]
    if (Object.keys(server.env ?? {}).length > 0) entry.env = { ...server.env }
  } else {
    entry.type = server.transport
    entry.url = server.url
    if (Object.keys(server.headers ?? {}).length > 0) entry.headers = { ...server.headers }
  }
  return JSON.stringify({ mcpServers: { [server.serverName]: entry } }, null, 2)
}

/**
 * Quote one argv token for the shorthand preview when it contains whitespace.
 * @param {string} arg
 * @returns {string}
 */
function quoteArg(arg) {
  const text = isJsExpr(arg) ? `!!js ${arg.__jsExpr}` : String(arg)
  return /[\s"']/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

// ── YAML plumbing ───────────────────────────────────────────────────────────

/**
 * Parse YAML without evaluating `!!js` expressions.
 *
 * The `!!js` tags in this file are real DSH syntax that the Loader evaluates.
 * This plugin must never evaluate them: the text came from a paste box, so an
 * expression is untrusted input. The YAML library is therefore called with an
 * explicit scalar resolver that keeps the source text as a string, which also
 * lets the value round-trip into the patch unchanged.
 *
 * `yaml` (eemeli/yaml) is the parser the Loader itself uses. The Host half
 * installs the module it resolved from the running Harness; keeping the lookup
 * injectable means this file stays a pure function of its input.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parseYamlDocument(text) {
  const runtime = globalThis.__dshMcpManagerYaml
  if (runtime === undefined || typeof runtime.parseDocument !== 'function') {
    throw new McpConfigError(
      '当前运行环境缺少 YAML 解析器；请改用 @mcp 简写格式导入，或手动编辑配置文件',
    )
  }
  const document = runtime.parseDocument(text, {
    customTags: [
      {
        tag: 'tag:yaml.org,2002:js',
        resolve: (value) => ({ __jsExpr: String(value) }),
      },
    ],
  })
  if (document.errors.length > 0) throw document.errors[0]
  return document.toJS()
}

/**
 * Install the YAML runtime this module needs. Called once by the Host half,
 * which resolves `yaml` from the running Harness' own dependency tree.
 * @param {{ parseDocument: Function }} module
 */
export function installYamlRuntime(module) {
  globalThis.__dshMcpManagerYaml = module
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
