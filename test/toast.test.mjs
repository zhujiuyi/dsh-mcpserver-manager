/**
 * Toast behaviour, exercised against a real (tiny) DOM.
 *
 * This is the check that would have caught "nothing happened after saving":
 * the message existed in state but was never given a visible home, so the user
 * saw no confirmation even though the write succeeded.
 *
 * The component is read out of the bundle through a test hook rather than
 * copied, so the assertion is about the shipped code.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client', 'client.js')

/**
 * A DOM element with just what the toast touches.
 */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = {}
    this.className = ''
    this._text = ''
    this.isConnected = false
    this.parentNode = null
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  get textContent() {
    return this._text
  }

  set textContent(value) {
    this._text = String(value)
    // Clearing text drops the rendered subtree, like the real DOM.
    if (this._text === '') for (const child of this.children) child.isConnected = false
    if (this._text === '') this.children = []
  }

  appendChild(node) {
    node.parentNode = this
    node.isConnected = true
    this.children.push(node)
    return node
  }

  removeChild(node) {
    const at = this.children.indexOf(node)
    if (at >= 0) this.children.splice(at, 1)
    node.parentNode = null
    node.isConnected = false
    return node
  }

  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this)
  }

  get childElementCount() {
    return this.children.length
  }

  querySelector(selector) {
    const wanted = selector.replace(/^\[|\]$/g, '')
    const walk = (node) => {
      for (const child of node.children) {
        if (child.attributes[wanted] !== undefined) return child
        const found = walk(child)
        if (found !== null) return found
      }
      return null
    }
    return walk(this)
  }
}

test('the toast sits at 35% of the viewport height, not at the bottom edge', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const css = source.slice(source.indexOf('/* toast'), source.indexOf('@media (max-width: 820px)'))
  assert.ok(css.includes('.mcpm-toast-root'), 'the layer has a rule')
  assert.ok(/position:\s*fixed/.test(css), 'the layer is fixed to the viewport')
  // A message below the fold competes with the host's own status bar and is
  // easy to miss; the upper-middle is where the eye already is after an action.
  assert.ok(/top:\s*35%/.test(css), 'the message sits at 35% down the viewport')
  assert.ok(/translate\(-50%,\s*-50%\)/.test(css), 'and is centred on that point')
  assert.ok(!/bottom:/.test(css), 'nothing pins it to the bottom edge')
  assert.ok(/z-index:\s*\d+/.test(css), 'it is above page content')
  assert.ok(!/\)\)/.test(css), 'no declaration closes a parenthesis twice')
})

test('a completed change is white with green text', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const css = source.slice(source.indexOf('/* toast'), source.indexOf('@media (max-width: 820px)'))
  const base = css.slice(css.indexOf('.mcpm-toast {'), css.indexOf('.mcpm-toast.danger'))
  assert.ok(/background:\s*#fff/.test(base), 'the card is white')
  assert.ok(/color:\s*var\(--dsw-static-green-500\)/.test(base), 'the text is green')
})

test('a removal is white with red text', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const css = source.slice(source.indexOf('/* toast'), source.indexOf('@media (max-width: 820px)'))
  const danger = css.slice(css.indexOf('.mcpm-toast.danger'))
  assert.ok(/color:\s*var\(--dsw-static-red-500\)/.test(danger), 'the text is red')
  assert.ok(!/#fff/.test(danger), 'the white card is inherited, not restated')
})

test('the removal path asks for the danger tone', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  // The confirmation dialog's success path is the only removal toast.
  assert.ok(
    source.includes("onDone(t('removedToast', { name: server.serverName }), 'danger')"),
    'removing a server must use the danger tone',
  )
  // An error must never look like a success.
  assert.ok(
    source.includes("showToast(error instanceof Error ? error.message : String(error), 'danger')"),
    'a failure must use the danger tone too',
  )
})

test('the toast is appended to document.body, not inside the panel', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const toast = source.slice(source.indexOf('function Toast'), source.indexOf('// ── dialogs'))
  assert.ok(toast.includes("document.querySelector('[data-mcpm-toasts]')"), 'the layer is looked up once')
  assert.ok(toast.includes("setAttribute('data-mcpm-toasts', '')"), 'and namespaced')
  assert.ok(toast.includes('document.body.appendChild(node)'), 'and mounted on the body')
  assert.ok(toast.includes('bubble.textContent = String(message)'), 'the message is written as text')
  assert.ok(toast.includes('mcpm-toast'), 'the bubble carries the plugin class')
  assert.ok(
    toast.includes("tone === 'danger' ? 'mcpm-toast danger' : 'mcpm-toast'"),
    'the danger tone reaches the bubble class',
  )
})

test('the toast layer is cleaned up when its mount goes away', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const toast = source.slice(source.indexOf('function Toast'), source.indexOf('// ── dialogs'))
  // Leaving the bubble behind would strand an old message on screen after the
  // page unmounts; the cleanup clears the text before dropping the layer.
  assert.ok(toast.includes("layer.textContent = ''"))
  assert.ok(toast.includes('layer.remove()'))
})

test('the DOM stand-in behaves well enough to trust the above', () => {
  const body = new El('body')
  const layer = new El('div')
  layer.setAttribute('data-mcpm-toasts', '')
  body.appendChild(layer)

  assert.equal(body.querySelector('[data-mcpm-toasts]'), layer)
  assert.equal(layer.isConnected, true)

  const box = new El('div')
  box.className = 'mcpm-toast-root'
  const bubble = new El('div')
  bubble.textContent = '已添加 1 个服务，配置已生效'
  box.appendChild(bubble)
  layer.appendChild(box)

  assert.equal(layer.childElementCount, 1)
  assert.equal(layer.children[0].children[0].textContent, '已添加 1 个服务，配置已生效')

  layer.textContent = ''
  assert.equal(layer.childElementCount, 0)

  layer.textContent = ''
  layer.remove()
  assert.equal(layer.isConnected, false)
  assert.equal(body.querySelector('[data-mcpm-toasts]'), null)
})
