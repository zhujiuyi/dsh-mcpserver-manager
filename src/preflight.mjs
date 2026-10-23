/**
 * @zhujiuyi/dsh-mcpserver-manager — configuration preflight.
 *
 * Answers one question before a server is saved or started: *would this
 * configuration have any chance of connecting?* It catches the failures a user
 * actually hits — a mistyped path, a command that is not on PATH, a bare
 * package name where an executable was expected, a URL that is not reachable —
 * without starting a process or opening a socket for every server.
 *
 * Why static checks rather than a real connection probe: spawning a server to
 * shake hands is the only way to be certain, but it costs a process per
 * server, runs untrusted code from a paste box, and needs the MCP client SDK
 * inside this bundle. Those checks belong to the runtime that already owns
 * them; this module deliberately stays cheap, offline and side-effect free, and
 * says "unknown" where a static answer cannot be given.
 *
 * Every finding is `{ level, code, message, field }`:
 *   - `error`   — the configuration cannot work as written;
 *   - `warning` — it may work, but a likely mistake is present;
 *   - `info`    — worth knowing, not a problem.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Severity ordering, so callers can take the worst finding. */
export const LEVELS = Object.freeze(['error', 'warning', 'info'])

/**
 * @typedef {object} Finding
 * @property {'error' | 'warning' | 'info'} level
 * @property {string} code      Stable identifier, safe to switch on.
 * @property {string} message   Shown to the user verbatim.
 * @property {string} [field]   Which form field the finding is about.
 */

/**
 * Expand `~` and `%VAR%` / `$VAR` so a path pasted from another tool resolves
 * the way the user expects.
 * @param {string} value
 * @param {Record<string, string>} [env]
 * @returns {string}
 */
export function expandPath(value, env = process.env) {
  let text = String(value ?? '').trim()
  if (text === '') return text

  // `~` only means the home directory at the start of a path.
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = resolve(homedir(), text.slice(2))

  // Windows `%NAME%`, and the `$NAME` / `${NAME}` form other tools use.
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) =>
    Object.hasOwn(env, name) ? env[name] : match,
  )
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, a, b) => {
    const name = a ?? b
    return Object.hasOwn(env, name) ? env[name] : match
  })
  return text
}

/**
 * Whether a string still contains an unexpanded variable reference.
 * @param {string} value
 * @returns {boolean}
 */
function hasUnresolvedVariable(value) {
  return /%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(String(value ?? ''))
}

/**
 * Resolve an executable the way the OS would.
 *
 * A bare name is searched on `PATH`; a path with a separator is checked
 * directly. On Windows the PATHEXT list decides which extensions count, so
 * `npx` resolves to `npx.cmd` rather than failing.
 *
 * @param {string} command
 * @param {{ env?: Record<string, string>, platform?: string }} [options]
 * @returns {{ found: boolean, path: string | null, searched: string[] }}
 */
export function resolveCommand(command, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const expanded = expandPath(command, env)
  const searched = []

  if (expanded === '') return { found: false, path: null, searched }

  // A path (absolute, or relative with a separator) is not searched on PATH.
  if (isAbsolute(expanded) || /[/\\]/.test(expanded)) {
    const candidates = platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(expanded)
      ? [`${expanded}.exe`, `${expanded}.cmd`, `${expanded}.bat`, expanded]
      : [expanded]
    for (const candidate of candidates) {
      searched.push(candidate)
      if (isExecutableFile(candidate)) return { found: true, path: candidate, searched }
    }
    return { found: false, path: null, searched }
  }

  const pathValue = env.PATH ?? env.Path ?? ''
  const dirs = pathValue.split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = resolve(dir, `${expanded}${extension}`)
      searched.push(candidate)
      if (isExecutableFile(candidate)) return { found: true, path: candidate, searched }
    }
  }
  return { found: false, path: null, searched }
}

/**
 * Whether a path is an existing regular file this process could execute.
 * @param {string} candidate
 * @returns {boolean}
 */
function isExecutableFile(candidate) {
  try {
    const info = statSync(candidate)
    if (!info.isFile()) return false
    // POSIX needs an executable bit; Windows has no such notion for a file.
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a string is shaped like an npm package specifier rather than a path.
 *
 * `@scope/name` and `name` are packages; `./x`, `../x`, `/x`, `C:\x` and
 * `x/y.exe` are paths. The distinction matters because the fix is different:
 * a package belongs in the arguments of `npx`, a path belongs in `command`.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPackageSpecifier(value) {
  const text = String(value ?? '').trim()
  if (text === '') return false
  // Anything with a drive letter, a leading dot/dot-dot, or a leading slash is
  // a path; so is anything ending in an executable extension.
  if (/^[A-Za-z]:[/\\]/.test(text)) return false
  if (/^\.{1,2}[/\\]/.test(text)) return false
  if (/^[/\\]/.test(text)) return false
  if (/\.(exe|cmd|bat|com|sh|ps1|mjs|cjs|js)$/i.test(text)) return false

  // An explicit scope is unambiguous: `@scope/name` cannot be a bare command.
  if (/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(text)) return true

  // `owner/name` with no extension is how an unscoped repo-style package is
  // written. A single bare word is left to the PATH check, because `npx` and
  // `node` are also bare words — reporting those as packages would be wrong.
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(text)
}

/**
 * Whether a string is shaped like a filesystem path.
 * @param {string} value
 * @returns {boolean}
 */
function isPathLike(value) {
  const text = String(value ?? '').trim()
  if (text === '') return false
  if (/^[A-Za-z]:[/\\]/.test(text)) return true
  if (/^\.{1,2}[/\\]/.test(text)) return true
  if (/^[/\\]/.test(text)) return true
  // `dir/tool` with an extension, or a bare name with an executable extension.
  return /\.(exe|cmd|bat|com|sh|ps1|mjs|cjs|js)$/i.test(text) || /[/\\].*\./.test(text)
}

/**
 * Run every static check for one server draft.
 *
 * @param {object} draft                     The draft being validated.
 * @param {{ env?: Record<string, string>, platform?: string, cwd?: string }} [options]
 * @returns {Finding[]}
 */
export function preflight(draft, options = {}) {
  /** @type {Finding[]} */
  const findings = []
  const push = (level, code, message, field) => findings.push({ level, code, message, field })

  const transport = draft?.transport === 'streamable-http' ? 'streamable-http' : 'stdio'

  if (transport === 'stdio') {
    checkStdio(draft, options, push, findings)
  } else {
    checkHttp(draft, options, push, findings)
  }

  // A per-call timeout far below a normal handshake turns into a spurious
  // failure the user would blame on the server.
  if (typeof draft?.toolCallTimeoutMs === 'number') {
    if (draft.toolCallTimeoutMs < 1000) {
      push('warning', 'timeout-too-low', `调用超时 ${draft.toolCallTimeoutMs}ms 偏小，握手可能来不及`, 'toolCallTimeoutMs')
    }
  }

  return findings
}

/**
 * stdio checks: the command must exist and the working directory must be real.
 * @param {any} draft
 * @param {any} options
 * @param {(level: string, code: string, message: string, field?: string) => void} push
 * @param {Finding[]} findings
 */
function checkStdio(draft, options, push, findings) {
  const env = options.env ?? process.env
  const command = String(draft?.command ?? '').trim()

  if (command === '') {
    push('error', 'command-missing', 'stdio 服务需要启动命令', 'command')
    return
  }

  if (hasUnresolvedVariable(command)) {
    push('warning', 'command-variable', `命令中仍有未展开的变量：${command}`, 'command')
  }

  const resolved = resolveCommand(command, { env, platform: options.platform })
  if (!resolved.found) {
    // Distinguish the shapes, because the fix differs. A scoped package
    // (`@scope/name`) contains a slash but is still a package, not a path, so
    // the package test must run before the path test.
    const looksLikePackage = isPackageSpecifier(command)
    if (looksLikePackage) {
      push(
        'error',
        'command-not-a-program',
        `“${command}” 看起来是 npm 包名，不是可执行文件。请把启动程序写成 npx（参数里放包名），或填可执行文件的完整路径`,
        'command',
      )
    } else if (isPathLike(command)) {
      push(
        'error',
        'command-path-missing',
        `找不到可执行文件：${expandPath(command, env)}`,
        'command',
      )
    } else {
      push(
        'error',
        'command-not-on-path',
        `PATH 中找不到命令 “${command}”。请填绝对路径，或先确认它已安装`,
        'command',
      )
    }
  } else if (resolved.path !== null && resolved.path !== expandPath(command, env)) {
    // Resolving a bare name to an extension is worth showing; it explains why
    // a `.cmd` shim behaves differently from the bare name on Windows.
    push('info', 'command-resolved', `“${command}” 解析为 ${resolved.path}`, 'command')
  }

  // env: keys are usually shell-style; a value still holding a variable will
  // reach the child literally, which is a frequent silent mistake.
  for (const [key, value] of Object.entries(draft?.env ?? {})) {
    const text = String(value ?? '')
    if (hasUnresolvedVariable(text)) {
      push(
        'warning',
        'env-variable',
        `环境变量 ${key} 的值里还有未展开的变量：${text}（dsh 不会替你展开）`,
        'env',
      )
    }
  }

  const cwd = String(draft?.cwd ?? '').trim()
  if (cwd !== '') {
    const expanded = expandPath(cwd, env)
    try {
      const info = statSync(expanded)
      if (!info.isDirectory()) {
        push('error', 'cwd-not-directory', `工作目录不是文件夹：${expanded}`, 'cwd')
      }
    } catch {
      push('error', 'cwd-missing', `工作目录不存在：${expanded}`, 'cwd')
    }
  }

  // The most common Windows trap: a nvm-managed global install disappears the
  // moment the active Node version changes.
  if (/[\\/]nvm[\\/]|[\\/]nvm4w[\\/]/i.test(command)) {
    push(
      'info',
      'nvm-path',
      '命令指向 nvm 的当前版本目录；切换 Node 版本后该路径会失效',
      'command',
    )
  }
}

/**
 * streamable-http checks: the URL must be well formed and plausibly an MCP
 * endpoint. Reachability is deliberately not attempted.
 * @param {any} draft
 * @param {any} options
 * @param {(level: string, code: string, message: string, field?: string) => void} push
 * @param {Finding[]} findings
 */
function checkHttp(draft, options, push, findings) {
  const url = String(draft?.url ?? '').trim()
  if (url === '') {
    push('error', 'url-missing', 'streamable-http 服务需要端点地址', 'url')
    return
  }
  if (hasUnresolvedVariable(url)) {
    push('warning', 'url-variable', `地址中仍有未展开的变量：${url}`, 'url')
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    push('error', 'url-invalid', `地址格式不正确：${url}`, 'url')
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    push('error', 'url-scheme', `仅支持 http(s) 地址：${url}`, 'url')
  }
  if (parsed.hostname === '0.0.0.0') {
    push('warning', 'url-any-address', '0.0.0.0 通常不是可连接的目标，请改用具体主机名', 'url')
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    push(
      'info',
      'url-no-path',
      '地址没有路径部分；多数 MCP 端点以 /mcp 结尾，请确认该主机根路径就是 MCP 端点',
      'url',
    )
  }
  for (const [key, value] of Object.entries(draft?.headers ?? {})) {
    if (String(value ?? '').trim() === '') {
      push('warning', 'header-empty', `请求头 ${key} 的值为空，可能被服务端拒绝`, 'headers')
    }
  }
}

/**
 * Summarise a finding list for display: the worst level decides.
 * @param {Finding[]} findings
 * @returns {{ level: 'error' | 'warning' | 'info' | 'ok', findings: Finding[] }}
 */
export function summarize(findings) {
  for (const level of LEVELS) {
    if (findings.some((finding) => finding.level === level)) {
      return { level: /** @type {any} */ (level), findings }
    }
  }
  return { level: 'ok', findings }
}
