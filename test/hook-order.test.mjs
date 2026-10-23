/**
 * Regression guard for the blank edit dialog.
 *
 * The component called two hooks only after its "still loading" early return, so
 * the render that finished loading called more hooks than the first render did.
 * React throws "Rendered more hooks than during the previous render" and unmounts
 * the subtree — the panel went blank instead of showing a dialog or an error.
 *
 * The assertion is deliberately narrow: within the component body, every hook
 * call must appear before the loading guard. That is the exact invariant React
 * requires, stated directly rather than inferred.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

const HOOK = /\b(useState|useEffect|useCallback|useMemo|useRef)\s*\(/g

test('the edit dialog declares every hook before its loading return', () => {
  const start = source.indexOf('function EditDialog(')
  const end = source.indexOf('function AddDialog(')
  assert.ok(start > 0 && end > start, 'EditDialog must exist and precede AddDialog')
  const body = source.slice(start, end)

  const guard = body.indexOf('if (form === null)')
  assert.ok(guard > 0, 'the loading guard is still present')

  const hooksAfter = [...body.slice(guard).matchAll(HOOK)].map((m) => m[1])
  assert.deepEqual(
    hooksAfter,
    [],
    `EditDialog calls ${hooksAfter.join(', ')} after its early return; React will ` +
      'throw on the render that passes the guard and the panel will go blank',
  )

  assert.ok(body.indexOf('const parseText = useCallback(') < guard, 'parseText must precede the guard')
  assert.ok(body.indexOf('return parseText(text)') < guard, 'its effect must precede the guard')
  assert.equal(
    (body.match(/const parseText = useCallback\(/g) ?? []).length,
    1,
    'parseText must be declared exactly once',
  )
})
