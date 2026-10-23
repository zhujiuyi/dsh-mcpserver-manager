/**
 * Every class the bundle renders must have a rule in its stylesheet.
 *
 * A class name is easy to add to JSX and easy to forget in CSS. When that
 * happens the element falls back to the browser's default styling: an unstyled
 * `<button>` renders as a grey beveled box, which is how the dialect switch
 * ended up looking like two foreign controls in an otherwise themed dialog.
 *
 * Modifier classes (`mcpm-dot connected`) and state classes that the host adds
 * are checked too, but a class only needs a rule somewhere — not necessarily its
 * own standalone rule.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/** The CSS string literal. */
const css = source.match(/const CSS = `([\s\S]*?)\n`/)[1]

/** Class names declared in CSS selectors. */
const defined = new Set()
for (const match of css.matchAll(/\.(mcpm-[a-z0-9-]+)/g)) defined.add(match[1])

/**
 * Classes the code puts on elements.
 *
 * Collected from `className: 'literal'`, template literals inside className,
 * and `className: \`...${...}...\`` — the dynamic ones are split so each static
 * fragment is visible.
 */
const used = new Set()

// className: 'a b c'
for (const match of source.matchAll(/className:\s*'([^']+)'/g)) {
  for (const name of match[1].split(/\s+/)) if (name) used.add(name)
}
// className: "a b c"
for (const match of source.matchAll(/className:\s*"([^"]+)"/g)) {
  for (const name of match[1].split(/\s+/)) if (name) used.add(name)
}
// className: `a ${x} b` — take the literal words, ignore the interpolations.
for (const match of source.matchAll(/className:\s*`([^`]+)`/g)) {
  const withoutExpressions = match[1].replace(/\$\{[^}]*\}/g, ' ')
  for (const name of withoutExpressions.split(/\s+/)) if (name) used.add(name)
}
// `element.className = 'a b'` and `x.className = cond ? 'a' : 'b'`
for (const match of source.matchAll(/\.className\s*=\s*([^\n]+)/g)) {
  for (const literal of match[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
    const value = literal[1] ?? literal[2]
    for (const name of value.split(/\s+/)) if (name) used.add(name)
  }
}
// setAttribute('class', 'a b')
for (const match of source.matchAll(/setAttribute\(\s*'class'\s*,\s*'([^']+)'/g)) {
  for (const name of match[1].split(/\s+/)) if (name) used.add(name)
}

const mcpmUsed = [...used].filter((name) => name.startsWith('mcpm-')).sort()
assert.ok(mcpmUsed.length > 30, `expected many classes, saw ${mcpmUsed.length}`)

test('every mcpm-* class used in the markup has a style rule', () => {
  const missing = mcpmUsed.filter((name) => !defined.has(name))
  assert.deepEqual(
    missing,
    [],
    `these classes are used but never styled, so the browser default shows through: ${missing.join(', ')}`,
  )
})

test('the dialect switch is a styled segmented control', () => {
  // The specific regression: two bare <button>s with an undefined class.
  assert.ok(defined.has('mcpm-seg'), 'the group is styled')
  assert.ok(defined.has('mcpm-seg-btn'), 'the buttons are styled')
  assert.ok(defined.has('mcpm-seg-btn'), 'and its selected state exists')

  // And the markup actually uses them together.
  assert.ok(source.includes("className: 'mcpm-seg'"), 'the group class is applied')
  assert.ok(source.includes('mcpm-seg-btn${'), 'the button class is applied with its state')
})

test('no stylesheet rule is dead weight', () => {
  // Every styled class should still be used somewhere; a rename leaves the old
  // rule behind and the new element unstyled.
  const unused = [...defined].filter((name) => !used.has(name)).sort()
  assert.deepEqual(unused, [], `these rules no longer match any element: ${unused.join(', ')}`)
})
