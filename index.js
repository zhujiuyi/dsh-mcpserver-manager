/**
 * @zhujiuyi/dsh-mcp-manager — host half.
 *
 * A standard DSH plugin: named exports `name` / `apply`, optional services,
 * no Config. It owns one job: expose the profile's MCP servers as a small HTTP
 * API the browser half drives, and write configuration changes back into
 * `cordis.patch.yml`.
 *
 * Routes (all under the Connection's authentication fence, like every other
 * host route):
 *
 *   GET    /api/mcp-manager/servers        — the inventory: servers, tools, state
 *   GET    /api/mcp-manager/server?id=    — one server, including its raw config
 *   POST   /api/mcp-manager/parse         — normalize pasted dsh / Claude JSON
 *   POST   /api/mcp-manager/add           — insert one or more servers
 *   POST   /api/mcp-manager/update        — replace one server's config
 *   POST   /api/mcp-manager/remove        — delete one server
 *   POST   /api/mcp-manager/toggle        — enable or disable one server
 *
 * Why the inventory reads the Loader tree rather than the patch file: the
 * effective configuration is the composition of several layers, and every row
 * already carries its resolved `config`. Reading the patch would miss servers
 * configured in a bundle or a home patch, and would misreport overridden
 * fields. The patch file is read only when writing, where it is the document
 * being edited.
 *
 * Writes use the same two mechanisms the rest of DSH uses:
 *   - an existing row's `config` is replaced through `ctx.configEditor.edit()`,
 *     which validates the complete candidate, preserves comments and `!!js`
 *     expressions, and applies the change atomically;
 *   - adding and removing rows is done by editing the patch document directly,
 *     because `configEditor` only edits rows that already exist. HMR watches
 *     the patch file, so the write is itself the reload trigger.
 */

import { join } from 'node:path'
import { resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'

import { createInventoryService, jsonSafe } from './src/inventory.mjs'
import { editPatch, insertRow, readPatch, removeRow, replaceRow, PatchEditError, scanStructure } from './src/patch-edit.mjs'
import {
  MCP_CLIENT_PACKAGE,
  McpConfigError,
  finalizeDraft,
  installYamlRuntime,
  messageOf,
  parseAny,
  parseClaudeJson,
  parseDshString,
  suggestRowId,
  toClaudeJsonPreview,
  toDshEntry,
  toDshPreview,
} from './src/parse.mjs'

/** Package name; also the client module id and the Loader row's plugin name. */
export const name = '@zhujiuyi/dsh-mcp-manager'

/** Optional services; every one of them is probed rather than required. */
export const inject = []

/** Route prefix owned by this plugin. */
export const API_PREFIX = '/api/mcp-manager'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /** @type {any} */
  let loader
  /** @type {any} */
  let tools
  /** @type {any} */
  let configEditor
  /** @type {any} */
  let profileContext

  ctx.inject(['loader'], (scoped) => {
    loader = scoped.loader
  })
  ctx.inject(['tools'], (scoped) => {
    tools = scoped.tools
  })
  ctx.inject(['configEditor'], (scoped) => {
    configEditor = scoped.configEditor
  })
  ctx.inject(['profileContext'], (scoped) => {
    profileContext = scoped.profileContext
  })

  // Give the parser the Harness' own YAML implementation. It is imported here,
  // inside the running process, because the plugin cannot resolve `yaml` from
  // its own module graph — the Harness ships it inside its asar archive.
  void installHarnessYaml()

  /**
   * The profile patch this plugin writes.
   * @returns {string}
   */
  function patchPath() {
    try {
      const fromProfile = profileContext?.patchPath
      if (typeof fromProfile === 'string' && fromProfile !== '') return fromProfile
    } catch {
      // Fall through to the derived location.
    }
    // Derive it the way app-boot does: `<profile dir>/cordis.patch.yml`, with
    // the profile directory taken from the environment the Harness exports.
    const profileDir = process.env.DSH_PROFILE_DIR
    if (typeof profileDir === 'string' && profileDir.trim() !== '') {
      return join(resolvePath(profileDir.trim()), 'cordis.patch.yml')
    }
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const profileName = process.env.DSH_PROFILE ?? 'desktop'
    return join(resolvePath(home), 'profiles', profileName, 'cordis.patch.yml')
  }

  const inventory = createInventoryService({
    loader: () => loader,
    tools: () => tools,
    patchPath,
    warn: (message) => warn(ctx, message),
  })

  ctx.inject(['connection'], (scoped) => {
    const conn = scoped.connection
    if (conn === undefined || conn === null || typeof conn.fetch?.register !== 'function') {
      warn(ctx, 'connection service unavailable; the MCP manager UI has no data route')
      return
    }
    const routes = [
      { path: `${API_PREFIX}/servers`, methods: ['GET'], handler: handleServers },
      { path: `${API_PREFIX}/server`, methods: ['GET'], handler: handleServer },
      { path: `${API_PREFIX}/parse`, methods: ['POST'], handler: handleParse },
      { path: `${API_PREFIX}/add`, methods: ['POST'], handler: handleAdd },
      { path: `${API_PREFIX}/update`, methods: ['POST'], handler: handleUpdate },
      { path: `${API_PREFIX}/remove`, methods: ['POST'], handler: handleRemove },
      { path: `${API_PREFIX}/toggle`, methods: ['POST'], handler: handleToggle },
    ]
    for (const route of routes) {
      try {
        scoped.effect(
          () =>
            conn.fetch.register({
              path: route.path,
              methods: route.methods,
              requestBody: 'buffered',
              fetch: (request) => guarded(route.handler, request),
            }),
          `mcp-manager: ${route.path}`,
        )
      } catch (error) {
        warn(ctx, `route ${route.path} registration skipped: ${messageOf(error)}`)
      }
    }
  })

  /**
   * Wrap a handler so a thrown error becomes a JSON 4xx/5xx rather than a
   * broken response, and so no user-facing message is ever swallowed.
   * @param {(request: Request) => Promise<Response>} handler
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function guarded(handler, request) {
    try {
      return await handler(request)
    } catch (error) {
      const status = error instanceof McpConfigError || error instanceof PatchEditError ? 400 : 500
      const reason = messageOf(error)
      warn(ctx, `${new URL(request.url).pathname} failed: ${reason}`)
      return jsonResponse({ ok: false, error: reason }, status)
    }
  }

  // ── GET /servers ──────────────────────────────────────────────────────────

  /**
   * @returns {Promise<Response>}
   */
  async function handleServers() {
    const snapshot = inventory.snapshot()
    return jsonResponse({
      ok: true,
      ...snapshot,
      // The browser half cannot assume an edit path exists; say so explicitly.
      canEditConfig: configEditor !== undefined && typeof configEditor.edit === 'function',
    })
  }

  // ── GET /server?id=<loader id> ─────────────────────────────────────────────

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleServer(request) {
    const url = new URL(request.url)
    const id = url.searchParams.get('id') ?? ''
    const snapshot = inventory.snapshot()
    const server = snapshot.servers.find((candidate) => candidate.id === id) ??
      snapshot.servers.find((candidate) => candidate.serverName === id)
    if (server === undefined) {
      return jsonResponse({ ok: false, error: `找不到服务 “${id}”` }, 404)
    }
    const draft = draftOf(server)
    return jsonResponse({
      ok: true,
      server,
      draft,
      preview: { dsh: safePreview(() => toDshPreview(draft)), json: safePreview(() => toClaudeJsonPreview(draft)) },
    })
  }

  // ── POST /parse ───────────────────────────────────────────────────────────

  /**
   * Normalize pasted text into drafts. This is the piece that turns a Claude
   * Code `mcpServers` block into dsh's accepted shape.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleParse(request) {
    const body = await readJson(request)
    const text = typeof body.text === 'string' ? body.text : ''
    const explicit = typeof body.dialect === 'string' ? body.dialect : 'auto'

    let parsed
    if (explicit === 'dsh') parsed = { dialect: 'dsh', drafts: parseDshString(text) }
    else if (explicit === 'json') parsed = { dialect: 'json', drafts: parseClaudeJson(text) }
    else parsed = parseAny(text)

    const snapshot = inventory.snapshot()
    const existing = new Set(snapshot.servers.map((server) => server.serverName.toLowerCase()))
    const duplicateInside = new Set()
    const seen = new Set()

    const items = parsed.drafts.map((draft) => {
      const key = draft.serverName.toLowerCase()
      const duplicated = existing.has(key) || seen.has(key)
      if (seen.has(key)) duplicateInside.add(draft.serverName)
      seen.add(key)
      const row = toDshEntry(draft)
      return {
        serverName: draft.serverName,
        transport: draft.transport,
        endpoint: typeof draft.url === 'string' ? draft.url : [draft.command, ...(draft.args ?? [])].join(' '),
        rowId: row.id,
        row,
        preview: { dsh: safePreview(() => toDshPreview(draft)), json: safePreview(() => toClaudeJsonPreview(draft)) },
        duplicate: existing.has(key),
        duplicatedInInput: duplicateInside.has(draft.serverName),
      }
    })

    return jsonResponse({
      ok: true,
      dialect: parsed.dialect,
      items,
      warnings: buildImportWarnings(items),
    })
  }

  // ── POST /add ─────────────────────────────────────────────────────────────

  /**
   * Insert one or more servers. Each server becomes one loader row; the row id
   * is derived from `serverName` and must stay unique.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleAdd(request) {
    const body = await readJson(request)
    const rawDrafts = Array.isArray(body.drafts) ? body.drafts : []
    if (rawDrafts.length === 0) throw new McpConfigError('没有要添加的服务')

    const drafts = rawDrafts.map((raw) => finalizeDraft(raw))
    const snapshot = inventory.snapshot()
    const takenNames = new Set(snapshot.servers.map((server) => server.serverName.toLowerCase()))
    const takenIds = new Set(snapshot.servers.map((server) => server.id))
    const seen = new Set()

    /** @type {Record<string, any>[]} */
    const rows = []
    for (const draft of drafts) {
      const key = draft.serverName.toLowerCase()
      if (takenNames.has(key) || seen.has(key)) {
        throw new McpConfigError(`已存在同名服务 “${draft.serverName}”，请先改名或删除原有条目`)
      }
      seen.add(key)
      let rowId = suggestRowId(draft.serverName)
      let suffix = 2
      while (takenIds.has(rowId)) {
        rowId = `${suggestRowId(draft.serverName)}-${suffix}`
        suffix += 1
      }
      takenIds.add(rowId)
      rows.push(toDshEntry(draft, { id: rowId }))
    }

    const path = patchPath()
    const expected = rows.map((row) => String(row.id))
    let index = 0
    const result = await editPatch(path, ({ lines, eol }) => {
      let working = lines
      for (const row of rows) {
        working = insertRow(working, eol, row)
        index += 1
      }
      return { lines: working, expectIds: expected }
    })

    return jsonResponse({
      ok: true,
      added: rows.map((row) => ({ id: row.id, serverName: row.config.serverName })),
      patchPath: path,
      backup: result.backup,
      changed: result.changed,
      // HMR watches the patch file; the change is live without a restart.
      reload: 'hmr',
    })
  }

  // ── POST /update ──────────────────────────────────────────────────────────

  /**
   * Replace one existing server's configuration.
   *
   * Prefers `configEditor.edit()`, which is the officially supported path and
   * validates the candidate against the plugin's Config schema before writing.
   * Falls back to a direct row replacement only when that service is absent.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleUpdate(request) {
    const body = await readJson(request)
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') throw new McpConfigError('缺少要修改的条目 id')

    const snapshot = inventory.snapshot()
    const server = snapshot.servers.find((candidate) => candidate.id === id)
    if (server === undefined) {
      // The Loader view can lag a just-written file by one recomposition. The
      // patch itself is authoritative, so confirm against it before refusing.
      const present = await rowInPatch(patchPath(), id)
      if (!present) throw new McpConfigError(`找不到条目 “${id}”`)
    }
    const existing = server ?? { id, serverName: '', disabled: false }

    const draft = finalizeDraft({ ...body.draft, id })
    if (existing.serverName !== '' && draft.serverName.toLowerCase() !== existing.serverName.toLowerCase()) {
      const clash = snapshot.servers.some(
        (candidate) =>
          candidate.id !== id &&
          candidate.serverName.toLowerCase() === draft.serverName.toLowerCase(),
      )
      if (clash) throw new McpConfigError(`已存在名为 “${draft.serverName}” 的服务`)
    }

    const row = toDshEntry(draft, { id })

    // Path 1: the official editor, when it can address this row.
    if (configEditor !== undefined && typeof configEditor.edit === 'function') {
      const entry = inventory
        .allEntries()
        .find((candidate) => String(candidate?.options?.id) === id)
      if (entry !== undefined) {
        try {
          await configEditor.edit(entry, () => jsonSafe(row.config))
          return jsonResponse({
            ok: true,
            updated: { id, serverName: draft.serverName },
            via: 'configEditor',
            reload: 'hmr',
          })
        } catch (error) {
          // A row that the editor refuses to address (for example one created
          // by a bundle layer) is still editable as a patch row; fall through
          // rather than leaving the user stuck.
          warn(ctx, `configEditor.edit failed for ${id}, falling back to patch edit: ${messageOf(error)}`)
        }
      }
    }

    // Path 2: direct row replacement.
    const path = patchPath()
    const result = await editPatch(path, ({ lines, eol }) => ({
      lines: replaceRow(lines, eol, id, row),
      expectIds: [id],
    }))

    return jsonResponse({
      ok: true,
      updated: { id, serverName: draft.serverName },
      via: 'patch',
      patchPath: path,
      backup: result.backup,
      changed: result.changed,
      reload: 'hmr',
    })
  }

  // ── POST /remove ──────────────────────────────────────────────────────────

  /**
   * Remove one server's row.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleRemove(request) {
    const body = await readJson(request)
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') throw new McpConfigError('缺少要删除的条目 id')

    const snapshot = inventory.snapshot()
    const server = snapshot.servers.find((candidate) => candidate.id === id)
    const path = patchPath()
    if (server === undefined && !(await rowInPatch(path, id))) {
      throw new McpConfigError(`找不到条目 “${id}”`)
    }

    // Refuse a row this profile does not own: it would be recreated by the
    // layer that supplies it, so deleting it here would only look successful.
    if (server !== undefined && ownedByAnotherLayer(server)) {
      throw new McpConfigError(
        `条目 “${id}” 由 profile 之外的层提供，无法在这里删除；请在提供它的配置中移除`,
      )
    }

    const result = await editPatch(path, ({ lines }) => ({
      lines: removeRow(lines, id),
      expectIds: [],
    }))

    return jsonResponse({
      ok: true,
      removed: { id, serverName: server?.serverName ?? id },
      patchPath: path,
      backup: result.backup,
      changed: result.changed,
      reload: 'hmr',
    })
  }

  // ── POST /toggle ──────────────────────────────────────────────────────────

  /**
   * Enable or disable one server by writing the row's `disabled` flag.
   *
   * A disabled row stays in the file (and keeps its configuration) but is not
   * started, which is the documented way to park a server.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleToggle(request) {
    const body = await readJson(request)
    const id = typeof body.id === 'string' ? body.id : ''
    const disabled = body.disabled === true
    if (id === '') throw new McpConfigError('缺少要切换的条目 id')

    const snapshot = inventory.snapshot()
    const server = snapshot.servers.find((candidate) => candidate.id === id)
    const path = patchPath()
    if (server === undefined) {
      // Same tolerance as /update: a row written moments ago can be on disk
      // before the Loader view catches up.
      if (!(await rowInPatch(path, id))) throw new McpConfigError(`找不到条目 “${id}”`)
    }

    const row = server === undefined ? null : { ...toDshEntry(draftOf(server), { id }) }
    const rowToWrite = row ?? (await rowFromPatch(path, id))
    if (disabled) rowToWrite.disabled = true
    else delete rowToWrite.disabled

    const result = await editPatch(path, ({ lines, eol }) => ({
      lines: replaceRow(lines, eol, id, rowToWrite),
      expectIds: [id],
    }))

    return jsonResponse({
      ok: true,
      toggled: { id, serverName: server?.serverName ?? id, disabled },
      patchPath: path,
      backup: result.backup,
      changed: result.changed,
      reload: 'hmr',
    })
  }

  /**
   * Whether a row is supplied by a layer above the profile patch.
   *
   * The profile patch is the only write target this plugin has, so a row that
   * came from a bundle or a home patch cannot be removed here. The check is
   * deliberately conservative: only rows the profile patch itself carries are
   * treated as removable.
   * @param {{ id: string }} server
   * @returns {boolean}
   */
  function ownedByAnotherLayer(server) {
    try {
      const entry = inventory.allEntries().find((candidate) => String(candidate?.options?.id) === server.id)
      if (entry === undefined) return false
      // The Loader records the patch that supplied an entry; when it names the
      // profile patch, this plugin may write it.
      const source = entry?.parent?.tree?.ctx?.fiber?.entry?.source ?? entry?.source
      if (typeof source === 'string' && source !== '') {
        return !source.endsWith('cordis.patch.yml')
      }
      return false
    } catch {
      return false
    }
  }

  void configEditor
}

/**
 * Rebuild one row's write shape from the patch itself.
 *
 * Used only when the Loader view has not caught up with the file yet: the row
 * exists on disk, so its own rendered block is the best available source of
 * truth for everything the caller is not changing.
 *
 * @param {string} path
 * @param {string} id
 * @returns {Promise<Record<string, any>>}
 */
async function rowFromPatch(path, id) {
  const { lines } = await readPatch(path)
  const found = scanStructure(lines).rows.find((row) => row.id === id)
  if (found === undefined) throw new McpConfigError(`配置文件里找不到条目 “${id}”`)

  const block = lines.slice(found.rowStart, found.rowEnd)
  const row = { id, name: MCP_CLIENT_PACKAGE, config: {} }
  let section = null
  for (const line of block) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const match = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(trimmed.replace(/^-\s+/, ''))
    if (match === null) continue
    const key = match[1]
    const value = match[2].trim()

    if (indent <= found.rowIndent + 2) {
      if (key === 'name') row.name = unquote(value)
      else if (key === 'disabled') row.disabled = value === 'true'
      else if (key === 'config') section = 'config'
      else section = null
      continue
    }
    if (section === 'config') {
      if (value === '') {
        section = `config.${key}`
        row.config[key] = key === 'env' || key === 'headers' ? {} : []
        continue
      }
      row.config[key] = scalarValue(value)
      continue
    }
    if (typeof section === 'string' && section.startsWith('config.')) {
      const name = section.slice('config.'.length)
      const bucket = row.config[name]
      if (Array.isArray(bucket)) {
        bucket.push(unquote(trimmed.replace(/^-\s+/, '')))
      } else if (bucket !== null && typeof bucket === 'object') {
        bucket[unquote(key)] = unquote(value)
      }
    }
  }
  return row
}

/**
 * @param {string} text
 * @returns {string}
 */
function unquote(text) {
  const value = String(text ?? '').trim()
  if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * @param {string} text
 * @returns {string | number | boolean}
 */
function scalarValue(text) {
  const value = unquote(text)
  if (/^-?\d+$/.test(value)) return Number(value)
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

/**
 * Whether the patch file currently holds a row with this id.
 *
 * The Loader's entry list reflects the last composition, which can trail a
 * write by one recomposition. Reading the document answers the question the
 * caller actually has ("is this row on disk right now?") without waiting.
 *
 * @param {string} path
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function rowInPatch(path, id) {
  try {
    const { lines } = await readPatch(path)
    return scanStructure(lines).rows.some((row) => row.id === id)
  } catch {
    return false
  }
}

/**
 * Project a managed server back into the draft shape the parsers produce, so
 * the detail page and the editor share one representation.
 * @param {{ config: Record<string, any> }} server
 * @returns {Record<string, any>}
 */
function draftOf(server) {
  const config = server.config ?? {}
  return {
    serverName: String(config.serverName ?? ''),
    transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: typeof config.command === 'string' ? config.command : '',
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    env: config.env !== null && typeof config.env === 'object' ? { ...config.env } : {},
    cwd: typeof config.cwd === 'string' ? config.cwd : '',
    url: typeof config.url === 'string' ? config.url : '',
    headers: config.headers !== null && typeof config.headers === 'object' ? { ...config.headers } : {},
    toolCallTimeoutMs:
      typeof config.toolCallTimeoutMs === 'number' ? config.toolCallTimeoutMs : 60000,
    failOnStartupError: config.failOnStartupError === true,
  }
}

/**
 * Run a preview renderer, degrading to an empty string instead of failing the
 * whole response for a value the preview cannot represent.
 * @param {() => string} render
 * @returns {string}
 */
function safePreview(render) {
  try {
    return render()
  } catch {
    return ''
  }
}

/**
 * @param {any[]} items
 * @returns {string[]}
 */
function buildImportWarnings(items) {
  /** @type {string[]} */
  const out = []
  const dupNames = items.filter((item) => item.duplicate).map((item) => item.serverName)
  if (dupNames.length > 0) {
    out.push(`已存在同名服务：${dupNames.join('、')}`)
  }
  const dupInside = items.filter((item) => item.duplicatedInInput).map((item) => item.serverName)
  if (dupInside.length > 0) {
    out.push(`粘贴内容中重复的服务名：${dupInside.join('、')}`)
  }
  return out
}

/**
 * Read a JSON request body, tolerating an empty body.
 * @param {Request} request
 * @returns {Promise<Record<string, any>>}
 */
async function readJson(request) {
  let text = ''
  try {
    text = await request.text()
  } catch {
    return {}
  }
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new McpConfigError('请求体不是合法 JSON')
  }
}

/**
 * @param {unknown} payload
 * @param {number} [status]
 * @returns {Response}
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Hand the parser the Harness' own `yaml` implementation.
 *
 * The `yaml` package lives inside the Harness' asar archive and is not
 * resolvable from a plugin's module graph, so it is imported here — inside the
 * running process, where the Host's own module resolution already reaches it.
 * When it cannot be loaded the parser degrades to the shorthand dialect and
 * says so, rather than failing the plugin.
 * @returns {Promise<void>}
 */
async function installHarnessYaml() {
  try {
    const mod = await import('yaml')
    installYamlRuntime(mod)
  } catch {
    // Leave the runtime uninstalled; parseDshString() reports the limitation
    // only when a user actually pastes a YAML-shaped patch.
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} text
 */
function warn(ctx, text) {
  try {
    ctx.logger?.warn?.(`[mcp-manager] ${text}`)
  } catch {
    // A missing logger must never be the reason a plugin fails.
  }
}

void MCP_CLIENT_PACKAGE
