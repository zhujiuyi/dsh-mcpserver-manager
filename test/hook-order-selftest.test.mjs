/**
 * Verify the hook-order test actually fails when the invariant is broken.
 *
 * A test that cannot fail is not a guard. This writes a deliberately broken copy
 * of the client (parse hooks moved below the loading guard) into a temporary
 * file, points the test's expectations at it, and confirms the check reports the
 * violation.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client', 'client.js')
const HOOK = /\b(useState|useEffect|useCallback|useMemo|useRef)\s*\(/g

/** The slice of source the invariant is checked over. */
function dialogBody(text) {
  const start = text.indexOf('function EditDialog(')
  const end = text.indexOf('function AddDialog(')
  return start > 0 && end > start ? text.slice(start, end) : null
}

/** Hooks that appear after the loading guard, which is the violation. */
function hooksAfterGuard(body) {
  const guard = body.indexOf('if (form === null)')
  if (guard < 0) return null
  return [...body.slice(guard).matchAll(HOOK)].map((match) => match[1])
}

test('the invariant holds in the shipped source', () => {
  const body = dialogBody(fs.readFileSync(CLIENT, 'utf8'))
  assert.ok(body !== null)
  assert.deepEqual(hooksAfterGuard(body), [])
})

test('the invariant is violated when a hook moves below the guard', () => {
  const original = fs.readFileSync(CLIENT, 'utf8')
  const body = dialogBody(original)
  assert.ok(body !== null)

  // Build a broken variant by duplicating a hook below the guard. This mimics
  // the exact shape of the original bug rather than relying on moving a block.
  const guardAt = original.indexOf('if (form === null)')
  const broken =
    original.slice(0, guardAt) +
    'if (form === null) {\n        const [x] = useState(0)\n        return null\n      }\n' +
    original.slice(guardAt)

  const brokenBody = dialogBody(broken)
  assert.ok(brokenBody !== null)

  // `useState` now sits after the guard, so the check must see it.
  const found = hooksAfterGuard(brokenBody)
  assert.ok(found !== null)
  assert.ok(
    found.includes('useState'),
    `the check must report the moved hook, saw: ${JSON.stringify(found)}`,
  )
})
