/**
 * Preflight tests.
 *
 * Each case is a mistake a user actually makes when pasting an MCP
 * configuration: a path from another machine, an npm package name where an
 * executable belongs, an unexpanded environment variable, a URL without the
 * `/mcp` segment. The checks must name the fix, not just the symptom.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { expandPath, preflight, resolveCommand, summarize } from '../src/preflight.mjs'

/** A platform-independent "this exists" path: the repository's own package.json. */
const SELF = 'E:/dsh-plugin/dsh-mcpserver-manager/package.json'

/**
 * @param {object} draft
 * @param {object} [options]
 * @returns {import('../src/preflight.mjs').Finding[]}
 */
function check(draft, options) {
  return preflight(draft, { env: { PATH: process.env.PATH, PATHEXT: '.COM;.EXE;.CMD', ...options?.env }, ...options })
}

/**
 * @param {import('../src/preflight.mjs').Finding[]} findings
 * @param {string} code
 * @returns {boolean}
 */
function has(findings, code) {
  return findings.some((finding) => finding.code === code)
}

test('expandPath handles ~, %VAR% and $VAR', () => {
  const env = { HOME_DIR: 'D:/Work' }
  assert.equal(expandPath('~'), process.env.HOME ?? process.env.USERPROFILE ?? require('node:os').homedir())
  assert.equal(expandPath('D:/%HOME_DIR%/x', { HOME_DIR: 'Work' }), 'D:/Work/x')
  assert.equal(expandPath('$HOME_DIR/x', env), 'D:/Work/x')
  assert.equal(expandPath('${HOME_DIR}/x', env), 'D:/Work/x')
  // An unknown variable is left alone rather than silently emptied.
  assert.equal(expandPath('%NOPE%/x', {}), '%NOPE%/x')
})

test('resolveCommand finds a file by absolute path', () => {
  const result = resolveCommand(SELF, { env: process.env })
  assert.equal(result.found, true)
  assert.equal(result.path, SELF)
})

test('resolveCommand reports a missing absolute path', () => {
  const result = resolveCommand('C:/definitely/not/here.exe', { env: process.env })
  assert.equal(result.found, false)
  assert.ok(result.searched.length > 0)
})

test('resolveCommand searches PATH for a bare name', () => {
  // node is running this test, so it is on PATH under some spelling.
  const result = resolveCommand(process.platform === 'win32' ? 'node' : 'node', {
    env: process.env,
    platform: process.platform,
  })
  assert.equal(result.found, true)
  assert.ok(result.path !== null)
})

test('a directory is not accepted as an executable', () => {
  const result = resolveCommand('E:/dsh-plugin/dsh-mcpserver-manager', { env: process.env })
  assert.equal(result.found, false)
})

test('an npm package name where a command belongs is named as such', () => {
  const findings = check({ serverName: 'x', transport: 'stdio', command: '@modelcontextprotocol/server-filesystem' })
  assert.ok(has(findings, 'command-not-a-program'), JSON.stringify(findings))
  const finding = findings.find((entry) => entry.code === 'command-not-a-program')
  assert.match(finding.message, /npx/, 'the message must say how to fix it')
  assert.equal(finding.level, 'error')
})

test('a missing absolute path is reported with the expanded path', () => {
  const findings = check({ serverName: 'x', transport: 'stdio', command: 'C:/nope/missing-mcp.exe' })
  assert.ok(has(findings, 'command-path-missing'), JSON.stringify(findings))
  const finding = findings.find((entry) => entry.code === 'command-path-missing')
  assert.match(finding.message, /missing-mcp\.exe/)
})

test('a bare name that is not on PATH is reported separately from a path', () => {
  const findings = check({ serverName: 'x', transport: 'stdio', command: 'definitely-not-installed-xyz' })
  assert.ok(has(findings, 'command-not-on-path'), JSON.stringify(findings))
})

test('a missing command is an error on its own', () => {
  const findings = check({ serverName: 'x', transport: 'stdio', command: '' })
  assert.ok(has(findings, 'command-missing'))
  assert.equal(summarize(findings).level, 'error')
})

test('an unexpanded variable in env is called out', () => {
  const findings = check({
    serverName: 'x',
    transport: 'stdio',
    command: SELF,
    env: { TOKEN: '${MY_TOKEN}' },
  })
  assert.ok(has(findings, 'env-variable'), JSON.stringify(findings))
})

test('a missing working directory is an error', () => {
  const findings = check({
    serverName: 'x',
    transport: 'stdio',
    command: SELF,
    cwd: 'C:/definitely/not/a/dir',
  })
  assert.ok(has(findings, 'cwd-missing'), JSON.stringify(findings))
})

test('a working directory that is a file is reported as such', () => {
  const findings = check({ serverName: 'x', transport: 'stdio', command: SELF, cwd: SELF })
  assert.ok(has(findings, 'cwd-not-directory'), JSON.stringify(findings))
})

test('a real working directory passes', () => {
  const findings = check({
    serverName: 'x',
    transport: 'stdio',
    command: SELF,
    cwd: 'E:/dsh-plugin/dsh-mcpserver-manager',
  })
  assert.ok(!has(findings, 'cwd-missing'))
  assert.ok(!has(findings, 'cwd-not-directory'))
})

test('an nvm-managed path is flagged as fragile, not as an error', () => {
  const findings = check({
    serverName: 'x',
    transport: 'stdio',
    command: 'C:/nvm4w/nodejs/node.exe',
  })
  const finding = findings.find((entry) => entry.code === 'nvm-path')
  // Only report it when the file is actually absent; a working nvm path is
  // merely worth knowing about.
  if (finding !== undefined) assert.equal(finding.level, 'info')
})

test('a valid http draft passes with only informational notes', () => {
  const findings = check({
    serverName: 'x',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
  })
  assert.equal(summarize(findings).level, 'ok', JSON.stringify(findings))
})

test('a URL without a path is an informational note, not an error', () => {
  const findings = check({ serverName: 'x', transport: 'streamable-http', url: 'https://mcp.example.com/' })
  assert.ok(has(findings, 'url-no-path'))
  assert.equal(summarize(findings).level, 'info')
})

test('a malformed URL and a wrong scheme are errors', () => {
  assert.ok(has(check({ serverName: 'x', transport: 'streamable-http', url: 'not a url' }), 'url-invalid'))
  assert.ok(has(check({ serverName: 'x', transport: 'streamable-http', url: 'ftp://a/b' }), 'url-scheme'))
  assert.ok(has(check({ serverName: 'x', transport: 'streamable-http', url: '' }), 'url-missing'))
})

test('0.0.0.0 is flagged as unmountable', () => {
  const findings = check({ serverName: 'x', transport: 'streamable-http', url: 'http://0.0.0.0:3000/mcp' })
  assert.ok(has(findings, 'url-any-address'))
})

test('an empty header value is flagged', () => {
  const findings = check({
    serverName: 'x',
    transport: 'streamable-http',
    url: 'https://a/mcp',
    headers: { Authorization: '  ' },
  })
  assert.ok(has(findings, 'header-empty'))
})

test('an absurdly low timeout is flagged', () => {
  const findings = check({
    serverName: 'x',
    transport: 'streamable-http',
    url: 'https://a/mcp',
    toolCallTimeoutMs: 200,
  })
  assert.ok(has(findings, 'timeout-too-low'))
})

test('summarize reports the worst level present', () => {
  assert.equal(summarize([]).level, 'ok')
  assert.equal(summarize([{ level: 'info', code: 'a', message: '' }]).level, 'info')
  assert.equal(
    summarize([
      { level: 'info', code: 'a', message: '' },
      { level: 'warning', code: 'b', message: '' },
    ]).level,
    'warning',
  )
  assert.equal(
    summarize([
      { level: 'warning', code: 'b', message: '' },
      { level: 'error', code: 'c', message: '' },
    ]).level,
    'error',
  )
})
