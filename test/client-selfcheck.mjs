/**
 * Client-bundle self-check.
 *
 * Runs `client/client.js` in a stubbed browser environment and asserts the
 * registration contract: the module loader receives the package id, the
 * returned object exposes `inject`/`apply`, and `apply` registers exactly the
 * two extension points the page needs (`main` keyed by the same id as the
 * `sidebar.panellist` row).
 *
 * This does not render React; it checks the contract a deployment depends on.
 * Rendering is verified in the running Harness.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client', 'client.js')
const PACKAGE_NAME = '@zhujiuyi/dsh-mcp-manager'

/**
 * Run the bundle and return what the loader and the registrations captured.
 */
function runBundle() {
  /** @type {any} */
  let registration
  /** @type {any[]} */
  const slotRegistrations = []
  /** @type {any[]} */
  const localeRegistrations = []
  /** @type {string[]} */
  const effects = []
  /** @type {any[]} */
  const styles = []

  /** Minimal React stand-in: createElement is all the bundle needs to define components. */
  const React = {
    createElement: (...args) => ({ type: typeof args[0], props: args[1] ?? {} }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }

  const documentStub = {
    baseURI: 'http://127.0.0.1:50649/',
    visibilityState: 'visible',
    hidden: false,
    head: {
      appendChild: (node) => styles.push(node),
    },
    createElement: (tag) => ({
      tag,
      textContent: '',
      style: {},
      setAttribute(key, value) {
        this[key] = value
      },
      remove() {},
      select() {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: () => true,
  }

  // Only host objects are injected. Built-ins (`Object`, `Array`, `JSON`, ...)
  // must come from the sandbox's own realm: passing the outer realm's copies in
  // would give the bundle two distinct `Object.prototype`s and break every
  // `instanceof`-free but still realm-sensitive check it makes.
  const context = {
    React,
    console,
    document: documentStub,
    navigator: { clipboard: undefined },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
  }

  const sandbox = {
    ...context,
    window: {
      __ModuleLoader__: {
        load(entry) {
          registration = entry
        },
      },
    },
  }
  // `vm.createContext` already makes the sandbox its own global object, so
  // `window` only has to carry the loader. Assigning the sandbox to itself as
  // `globalThis` would add a self-reference the context copier cannot walk.
  sandbox.window.window = undefined
  delete sandbox.window.window

  const source = fs.readFileSync(CLIENT, 'utf8')
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client/client.js' })

  assert.ok(registration !== undefined, 'the bundle must register with the module loader')
  assert.equal(registration.id, PACKAGE_NAME, 'the loader id must equal the package name')

  const factoryResult = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require('${specifier}')`)
  })

  assert.ok(factoryResult !== null && typeof factoryResult === 'object', 'factory must return an object')
  assert.ok(Array.isArray(factoryResult.inject), 'inject must be an array')
  assert.equal(typeof factoryResult.apply, 'function', 'apply must be a function')

  const localeApi = {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {}
    },
    bind(namespace) {
      return (key) => `${namespace}.${key}`
    },
  }

  const slotApi = {
    inject(owner, callback) {
      callback()
    },
    register(options, component) {
      slotRegistrations.push({ options, component })
      return () => {}
    },
  }

  const ctx = {
    // Cordis hands the declared services over as context properties; `inject`
    // additionally waits for them to become available.
    slots: slotApi,
    locale: localeApi,
    effect(factory, label) {
      effects.push(label ?? 'unnamed')
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, callback) {
      // Only `slots` and `locale` are declared; hand them over together.
      callback({ slots: slotApi, locale: localeApi })
    },
    get(name) {
      if (name === 'slots') return slotApi
      if (name === 'locale') return localeApi
      return undefined
    },
    logger: { warn: () => {} },
  }

  factoryResult.apply(ctx)

  return {
    registration,
    factoryResult,
    slotRegistrations,
    localeRegistrations,
    effects,
    styles,
  }
}

test('the bundle registers under the package name', () => {
  const run = runBundle()
  assert.equal(run.registration.id, PACKAGE_NAME)
})

test('the plugin declares the slots and locale services', () => {
  const run = runBundle()
  // The array comes from the sandbox realm, so compare contents rather than
  // identity (`deepEqual` would reject a cross-realm array).
  const inject = Array.from(run.factoryResult.inject)
  assert.deepEqual(inject, ['slots', 'locale'])
})

test('apply registers a main page and a sidebar row that share one id', () => {
  const run = runBundle()
  const names = run.slotRegistrations.map((entry) => entry.options.name)
  assert.deepEqual(names.sort(), ['main', 'sidebar.panellist'])

  const main = run.slotRegistrations.find((entry) => entry.options.name === 'main')
  const row = run.slotRegistrations.find((entry) => entry.options.name === 'sidebar.panellist')

  assert.equal(main.options.key, 'mcp-manager')
  assert.equal(row.options.id, 'mcp-manager')
  // The equality is the whole link between the row and the page.
  assert.equal(main.options.key, row.options.id)
  assert.equal(typeof row.options.order, 'number')
  assert.equal(main.options.locale, 'mcpManager')
})

test('apply registers zh and en dictionaries with identical keys', () => {
  const run = runBundle()
  assert.equal(run.localeRegistrations.length, 1)
  const { namespace, dictionaries } = run.localeRegistrations[0]
  assert.equal(namespace, 'mcpManager')
  assert.ok(dictionaries.zh !== undefined)
  assert.ok(dictionaries.en !== undefined)

  const zhKeys = Object.keys(dictionaries.zh).sort()
  const enKeys = Object.keys(dictionaries.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh and en must cover the same keys')
  assert.ok(zhKeys.length > 50, 'the dictionary should cover the whole page')
})

test('apply installs one plugin-scoped stylesheet and two effects', () => {
  const run = runBundle()
  assert.equal(run.styles.length, 1)
  assert.equal(run.styles[0]['data-plugin'], PACKAGE_NAME)
  assert.ok(run.styles[0].textContent.length > 2000, 'the stylesheet carries the page CSS')
  assert.equal(run.effects.length, 2)
})

test('the stylesheet references only theme tokens for colour, no hard-coded neutrals', () => {
  const run = runBundle()
  const css = run.styles[0].textContent

  // Every colour must come from a token, so a theme swap degrades rather than breaks.
  assert.ok(css.includes('var(--dsw-alias-'), 'colour must come from alias tokens')

  // The prototype's hard-coded dark palette must not survive.
  for (const hex of ['#0A0C0D', '#0a0c0d', '#121618', '#171C1F', '#1C2226', '#232A2E', '#5FCDB4']) {
    assert.ok(!css.includes(hex), `hard-coded colour ${hex} must not appear in the stylesheet`)
  }
})

test('the sidebar row renders an svg at the size the host passes', () => {
  const run = runBundle()
  const row = run.slotRegistrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(typeof row.component, 'function')

  const wide = row.component({ size: 18, active: true })
  assert.equal(wide.props.width, 18)
  const collapsed = row.component({ size: 16, active: false })
  assert.equal(collapsed.props.width, 16)
  // A missing size must still produce a usable glyph.
  const bare = row.component({})
  assert.equal(typeof bare.props.width, 'number')
})

test('the page component is a function of its locale-bound t', () => {
  const run = runBundle()
  const main = run.slotRegistrations.find((entry) => entry.options.name === 'main')
  assert.equal(typeof main.component, 'function')
  // `locale` + `inject` are what hand the page its `t`.
  assert.equal(main.options.locale, 'mcpManager')
  assert.equal(typeof main.options.inject, 'function')
  const injected = main.options.inject()
  assert.equal(typeof injected.t, 'function')
})

test('no Harness client package is required as a module', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  // The only allowed platform-seed import is `react`.
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'])
  assert.ok(!source.includes("require('@deepseek-ai/"), 'no dsh-client-* package may be required')
})

test('the bundle never writes outside its own slot', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  // Strip comments: the copy helper's own explanation mentions these APIs.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!source.includes("innerHTML = '<"), 'no HTML-string rendering')
  // The clipboard fallback is the one documented exception: a `<textarea>`
  // appended outside the slot is how `execCommand('copy')` is reached when
  // `navigator.clipboard` is unavailable. It is removed in the same call.
  const bodyWrites = (code.match(/document\.body\.appendChild\(/g) ?? []).length
  assert.equal(bodyWrites, 1, 'only the clipboard fallback may touch document.body')
  assert.ok(code.includes('document.body.removeChild('), 'and it must clean up after itself')
  // Nothing else may reach for the host DOM root.
  assert.ok(!code.includes("document.body.innerHTML"))
  assert.ok(!code.includes('document.documentElement'))
})
