/**
 * @zhujiuyi/dsh-mcp-manager — safe edits to the profile patch.
 *
 * The plugin performs three mutations on `cordis.patch.yml`:
 *
 *   - **insert** a new MCP row, inside an existing `- insert:` block when one
 *     is present, otherwise as a new block appended to the document;
 *   - **replace** one row's `config` in place;
 *   - **remove** one row, plus the `- insert:` wrapper when it becomes empty.
 *
 * Why this is a line-range editor rather than a YAML load-and-dump:
 *
 *   - The profile patch is a hand-maintained document full of comments,
 *     deliberate ordering, and `!!js` expressions that must never be
 *     re-rendered. A parse-then-serialize round trip destroys all three; the
 *     `yaml` library would preserve them, but it ships inside the Harness'
 *     asar and cannot be resolved from a plugin's own module graph.
 *   - Every mutation here replaces a *contiguous span of lines* that the
 *     plugin itself can delimit exactly (a row, from its `- id:` to the next
 *     sibling at the same indent). Nothing outside the span is touched, so
 *     comments and formatting elsewhere survive byte-for-byte.
 *
 * The trade-off is honest: this editor understands the *specific* shape the
 * MCP rows take (block-style sequences of block-style maps at a known indent),
 * not YAML in general. Anything it cannot delimit for certain is refused with
 * a clear message rather than guessed at.
 *
 * A write is atomic: the new text is re-validated by a structural scan, written
 * to a temp file, then renamed over the original. A failed edit leaves the
 * profile unchanged, and a backup is kept beside it.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { messageOf } from './parse.mjs'

/** Raised when the patch cannot be edited safely; nothing is written. */
export class PatchEditError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'PatchEditError'
  }
}

/**
 * @typedef {object} RowSpan
 * @property {number} blockStart   Line index of the `- insert:` (or the row itself when top-level).
 * @property {number} blockEnd     Exclusive end of the insert block.
 * @property {number} rowStart     First line of the row (`- id: ...`).
 * @property {number} rowEnd       Exclusive end of the row.
 * @property {string} id           The row's id.
 * @property {number} rowIndent    Indent of the `-` that starts the row.
 * @property {boolean} inInsert    Whether the row lives inside an `- insert:` block.
 */

/**
 * Split text into lines while remembering the original line terminator, so a
 * CRLF file is written back as CRLF.
 * @param {string} text
 * @returns {{ lines: string[], eol: string, trailingNewline: boolean }}
 */
export function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const normalized = eol === '\r\n' ? text.replace(/\r\n/g, '\n') : text
  const trailingNewline = normalized.endsWith('\n')
  const body = trailingNewline ? normalized.slice(0, -1) : normalized
  const lines = body === '' ? [] : body.split('\n')
  return { lines, eol, trailingNewline }
}

/**
 * Rebuild text from lines.
 * @param {string[]} lines
 * @param {string} eol
 * @param {boolean} trailingNewline
 * @returns {string}
 */
export function joinLines(lines, eol, trailingNewline) {
  if (lines.length === 0) return ''
  const body = lines.join(eol)
  return trailingNewline ? `${body}${eol}` : body
}

/**
 * Indentation of a line, or -1 for a blank line.
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  if (line.trim() === '') return -1
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].length
}

/**
 * Whether a line is a comment, blank, or a document marker.
 * @param {string} line
 * @returns {boolean}
 */
function isNoise(line) {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...'
}

/**
 * Read the id declared on a sequence item line, if the line starts one.
 * @param {string} line
 * @param {number} indent
 * @returns {string | null}
 */
function idOnLine(line, indent) {
  const rest = line.slice(indent)
  if (!rest.startsWith('- ')) return null
  // Match `- id: value` allowing an inline comment and either quote style.
  const match = /^-\s+id\s*:\s*(.*)$/.exec(rest)
  if (match === null) return null
  return matchedScalar(match[1])
}

/**
 * Strip quoting and inline comments from a scalar value.
 * @param {string} raw
 * @returns {string}
 */
function matchedScalar(raw) {
  let value = raw.trim()
  // Drop a trailing ` # comment` that is not inside quotes.
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1)
    if (end > 0) return value.slice(1, end)
  }
  const commentAt = value.search(/\s#/)
  if (commentAt >= 0) value = value.slice(0, commentAt).trim()
  return value
}

/**
 * Locate every `- insert:` block and, inside it, every MCP row.
 *
 * A block is `- insert:` at some indent followed by a sequence at a deeper
 * indent. It ends at the first line that is a non-blank, non-comment line at
 * an indent less than the block's own content indent.
 *
 * @param {string[]} lines
 * @returns {{ blocks: { start: number, end: number, contentIndent: number }[], rows: RowSpan[] }}
 */
export function scanStructure(lines) {
  /** @type {{ start: number, end: number, contentIndent: number }[]} */
  const blocks = []
  /** @type {RowSpan[]} */
  const rows = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (isNoise(line)) continue
    const indent = indentOf(line)
    const isInsert = /^\s*-\s+insert\s*:\s*$/.test(line)
    if (!isInsert) continue

    // The block's content begins after this line; find the sequence indent.
    let contentIndent = -1
    let end = lines.length
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      const probeLine = lines[probe]
      if (isNoise(probeLine)) continue
      const probeIndent = indentOf(probeLine)
      if (contentIndent < 0) {
        // The first real content line sets the sequence indent; it must be
        // deeper than the `- insert:` line and start a sequence item.
        if (probeIndent <= indent || !probeLine.slice(probeIndent).startsWith('- ')) {
          end = probe
          break
        }
        contentIndent = probeIndent
        continue
      }
      if (probeIndent < contentIndent) {
        end = probe
        break
      }
    }
    if (contentIndent < 0) {
      // `- insert:` with no sequence content: still record the span so callers
      // can clean up an empty wrapper, but it contributes no rows.
      blocks.push({ start: index, end, contentIndent: indent, empty: true })
      continue
    }
    blocks.push({ start: index, end, contentIndent, empty: false })

    // Collect the rows inside this block.
    for (let row = index + 1; row < end; row += 1) {
      const rowLine = lines[row]
      if (isNoise(rowLine)) continue
      if (indentOf(rowLine) !== contentIndent) continue
      if (!rowLine.slice(contentIndent).startsWith('- ')) continue

      const id = idOnLine(rowLine, contentIndent)
      let rowEnd = end
      for (let probe = row + 1; probe < end; probe += 1) {
        const probeLine = lines[probe]
        if (isNoise(probeLine)) continue
        if (indentOf(probeLine) === contentIndent && probeLine.slice(contentIndent).startsWith('- ')) {
          rowEnd = probe
          break
        }
      }
      // A row's span must not swallow the blank lines and column-0 comments
      // that annotate whatever follows it. Those belong to the next section:
      // the profile patch is full of `# next-feature — date` headers sitting
      // directly above a top-level row. Indented comments inside the row (for
      // example a note above `env:`) are deeper than the row's own `- `, so
      // they stay.
      let spanEnd = rowEnd
      while (spanEnd - 1 > row) {
        const tail = lines[spanEnd - 1]
        if (!isNoise(tail)) break
        if (indentOf(tail) > contentIndent) break
        spanEnd -= 1
      }
      rows.push({
        blockStart: index,
        blockEnd: end,
        rowStart: row,
        rowEnd: spanEnd,
        id: id ?? '',
        rowIndent: contentIndent,
        inInsert: true,
      })
      row = rowEnd - 1
    }
  }

  return { blocks, rows }
}

/**
 * Read and split the patch.
 * @param {string} path
 * @returns {Promise<{ text: string, lines: string[], eol: string, trailingNewline: boolean }>}
 */
export async function readPatch(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') text = '[]\n'
    else throw error
  }
  const { lines, eol, trailingNewline } = splitLines(text)
  return { text, lines, eol, trailingNewline }
}

/**
 * Find one MCP row by id.
 * @param {string[]} lines
 * @param {string} id
 * @returns {RowSpan}
 */
export function requireRow(lines, id) {
  const { rows } = scanStructure(lines)
  const hit = rows.find((row) => row.id === id)
  if (hit === undefined) {
    throw new PatchEditError(`配置文件中找不到 id 为 “${id}” 的 MCP 条目`)
  }
  return hit
}

/**
 * Render one row as patch YAML, at the requested indent.
 *
 * The renderer is deliberately explicit instead of generic: MCP rows use only
 * strings, string arrays, and string maps, so each of those is quoted exactly
 * the way the rest of the file quotes them.
 *
 * @param {Record<string, any>} row
 * @param {number} indent
 * @param {string} eol
 * @returns {string[]}
 */
export function renderRow(row, indent, eol) {
  const pad = ' '.repeat(indent)
  // The patch indents a sequence item's keys by two spaces past the `- `, and
  // that item's `config` children by two more. This mirrors the hand-written
  // rows exactly:
  //     - id: rea-mcp          indent + 0
  //       name: "..."          indent + 2
  //       config:              indent + 2
  //         serverName: rea    indent + 4
  //           KEY: value       indent + 6
  const keysIndent = ' '.repeat(indent + 2)
  const configIndent = ' '.repeat(indent + 4)
  const leafIndent = ' '.repeat(indent + 6)
  const out = [`${pad}- id: ${quoteScalar(row.id)}`, `${keysIndent}name: ${quoteScalar(row.name)}`]
  // `disabled` sits beside `name`, above `config`, the way the Loader documents
  // it. It is omitted entirely when the row is enabled, so an enabled row reads
  // exactly like a hand-written one.
  if (row.disabled === true) out.push(`${keysIndent}disabled: true`)

  const config = row.config ?? {}
  out.push(`${keysIndent}config:`)
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      out.push(`${configIndent}${key}:`)
      for (const item of value) out.push(`${configIndent}  - ${quoteScalar(item)}`)
      continue
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value)
      if (entries.length === 0) continue
      out.push(`${configIndent}${key}:`)
      for (const [innerKey, innerValue] of entries) {
        out.push(`${leafIndent}${quoteScalar(innerKey)}: ${quoteScalar(innerValue)}`)
      }
      continue
    }
    out.push(`${configIndent}${key}: ${renderScalar(value)}`)
  }
  void eol
  return out
}

/**
 * Quote a string scalar the way the surrounding patch does: plain when safe,
 * single-quoted otherwise. Single quotes keep Windows paths readable, which is
 * the common case for `command` values here.
 * @param {unknown} value
 * @returns {string}
 */
function quoteScalar(value) {
  const text = String(value ?? '')
  if (text === '') return "''"
  // Quote whenever any of these could change how YAML reads the scalar:
  //   - a leading indicator character (`-`, `?`, `:`, `,`, `[`, `]`, `{`, `}`,
  //     `#`, `&`, `*`, `!`, `|`, `>`, `'`, `"`, `%`, `@`, backtick);
  //   - whitespace anywhere, which keeps Windows paths readable and matches the
  //     quoting the hand-written rows already use;
  //   - a quote character anywhere, so the rendered value never depends on the
  //     reader's tolerance for a bare apostrophe;
  //   - a `: ` or ` #` sequence, which would end the scalar early;
  //   - a trailing colon, which reads as a mapping key;
  //   - any line break.
  if (
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /\s/.test(text) ||
    /['"]/.test(text) ||
    /:\s/.test(text) ||
    / #/.test(text) ||
    /:$/.test(text) ||
    /[\r\n]/.test(text)
  ) {
    return `'${text.replace(/'/g, "''")}'`
  }
  return text
}

/**
 * Render a non-string scalar (number, boolean) verbatim.
 * @param {unknown} value
 * @returns {string}
 */
function renderScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return quoteScalar(value)
}

/**
 * Insert a row into the document text.
 *
 * Appends to an existing MCP-bearing `- insert:` block when one exists (keeping
 * the file's shape), otherwise creates a fresh block at the end.
 *
 * @param {string[]} lines
 * @param {string} eol
 * @param {Record<string, any>} row
 * @returns {string[]}
 */
export function insertRow(lines, eol, row) {
  const { blocks, rows } = scanStructure(lines)

  // Prefer the insert block that already holds MCP rows.
  const withMcp = blocks.find((block) =>
    rows.some(
      (rowSpan) =>
        rowSpan.blockStart === block.start && lines[rowSpan.rowStart].includes('dsh-mcp-client'),
    ),
  )
  const target = withMcp ?? blocks.find((block) => !block.empty) ?? blocks[0]

  if (target !== undefined) {
    if (target.empty === true) {
      // An `- insert:` with no children: render the first row right after it at
      // the standard two-space child indent.
      const childIndent = target.contentIndent + 2
      const newLines = renderRow(row, childIndent, eol)
      return [...lines.slice(0, target.start + 1), ...newLines, ...lines.slice(target.start + 1)]
    }
    const newLines = renderRow(row, target.contentIndent, eol)
    // Insert before the block's trailing blank/comment tail so the comment
    // stays attached to what follows it rather than to the new row.
    let at = target.end
    while (at > target.start + 1 && isNoise(lines[at - 1])) at -= 1
    if (at <= target.start + 1) at = target.end
    return [...lines.slice(0, at), ...newLines, ...lines.slice(at)]
  }

  // No block yet: append one.
  const trailing = lines.length > 0 && lines[lines.length - 1].trim() === '' ? 1 : 0
  const body = trailing === 1 ? lines.slice(0, -1) : lines.slice()
  const block = ['- insert:', ...renderRow(row, 4, eol)]
  return [...body, ...block, ...(trailing === 1 ? [''] : [])]
}

/**
 * Replace one row's rendered block in place.
 * @param {string[]} lines
 * @param {string} eol
 * @param {string} id
 * @param {Record<string, any>} row
 * @returns {string[]}
 */
export function replaceRow(lines, eol, id, row) {
  const found = requireRow(lines, id)
  const rendered = renderRow(row, found.rowIndent, eol)
  return [...lines.slice(0, found.rowStart), ...rendered, ...lines.slice(found.rowEnd)]
}

/**
 * Remove one row, and its `- insert:` wrapper when nothing else remains.
 * @param {string[]} lines
 * @param {string} id
 * @returns {string[]}
 */
export function removeRow(lines, id) {
  const found = requireRow(lines, id)
  const without = [...lines.slice(0, found.rowStart), ...lines.slice(found.rowEnd)]

  // Re-scan the edited text. When the removed row was the block's only content,
  // the wrapper is now an `- insert:` with an empty sequence: drop it, together
  // with the blank separator line it leaves behind, so repeated removals do not
  // accumulate `- insert:` husks.
  const after = scanStructure(without)
  const block = after.blocks.find((candidate) => candidate.start === found.blockStart)
  if (block === undefined) return without
  const survivingRows = after.rows.filter((rowSpan) => rowSpan.blockStart === block.start)
  if (survivingRows.length > 0) return without

  // Try to swallow one adjacent blank line so the removal does not leave a
  // double gap where the block used to be.
  const out = [...without]
  const hasBlankAfter = block.end < out.length && out[block.end].trim() === ''
  const hasBlankBefore = block.start > 0 && out[block.start - 1].trim() === ''
  let start = block.start
  let end = block.end
  if (hasBlankAfter && !hasBlankBefore) end += 1
  else if (hasBlankBefore && !hasBlankAfter) start -= 1
  out.splice(start, end - start)
  return out
}

/**
 * Validate that the edited text still scans cleanly and keeps the expected row
 * set. This is a structural guard against a bad splice, not a full YAML parser.
 *
 * @param {string[]} beforeLines
 * @param {string[]} afterLines
 * @param {{ expectIds: string[] }} expectation
 * @returns {void}
 */
export function validateEdit(beforeLines, afterLines, expectation) {
  const after = scanStructure(afterLines)
  const ids = new Set(after.rows.map((row) => row.id))
  for (const id of expectation.expectIds) {
    if (!ids.has(id)) {
      throw new PatchEditError(`内部校验失败：编辑后缺少条目 “${id}”，已放弃写入`)
    }
  }
  // Every surviving row must still carry its own `- id:` line and a `name:`,
  // which catches a splice that cut a row in half.
  for (const row of after.rows) {
    if (row.id === '') {
      throw new PatchEditError('内部校验失败：编辑后出现无法识别的条目，已放弃写入')
    }
  }
  beforeCountGuard(beforeLines, afterLines)
}

/**
 * Count every top-level `- id:` row in a document, whether it sits inside an
 * `- insert:` block or stands on its own.
 *
 * The MCP scanner only reports rows inside insert blocks, because those are
 * the rows this plugin may edit. The row-count guard needs the whole document's
 * view, though: an edit that accidentally swallows a neighbouring top-level
 * override is just as wrong as one that swallows a sibling MCP row.
 *
 * @param {string[]} lines
 * @returns {number}
 */
export function countEntries(lines) {
  let count = 0
  for (const line of lines) {
    if (isNoise(line)) continue
    if (/^\s*-\s+id\s*:/.test(line)) count += 1
  }
  return count
}

/**
 * @param {string[]} beforeLines
 * @param {string[]} afterLines
 */
function beforeCountGuard(beforeLines, afterLines) {
  const beforeCount = countEntries(beforeLines)
  const afterCount = countEntries(afterLines)
  // An edit may add one row, remove one row, or replace one row in place. Any
  // larger swing means a splice went wrong, and is refused before the write.
  if (afterCount > beforeCount + 1 || afterCount < beforeCount - 1) {
    throw new PatchEditError(
      `内部校验失败：条目数量从 ${beforeCount} 变为 ${afterCount}，已放弃写入`,
    )
  }
}

/**
 * Copy the patch aside, following the profile's own `.bak-*` convention.
 * @param {string} path
 * @param {string} text
 * @returns {Promise<string | null>}
 */
export async function writeBackup(path, text) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
  const backupPath = `${path}.bak-mcpmanager-${stamp}`
  try {
    await writeFile(backupPath, text, 'utf8')
    return backupPath
  } catch {
    return null
  }
}

/**
 * Atomically replace the patch with `text`.
 * @param {string} path
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writePatchAtomic(path, text) {
  const tempPath = join(dirname(path), `.mcp-manager-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(tempPath, text, 'utf8')
    await rename(tempPath, path)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw new PatchEditError(`写入配置文件失败：${messageOf(error)}`)
  }
}

/**
 * Run one mutation as read → edit → validate → backup → atomic write.
 *
 * Nothing is written when the mutation throws or when validation fails, so a
 * refused edit is always a no-op on disk.
 *
 * @template T
 * @param {string} path
 * @param {(context: { lines: string[], eol: string, text: string }) => { lines: string[], expectIds?: string[] }} mutate
 * @returns {Promise<{ backup: string | null, changed: boolean }>}
 */
export async function editPatch(path, mutate) {
  const { text, lines, eol, trailingNewline } = await readPatch(path)
  const { lines: nextLines, expectIds = [] } = mutate({ lines, eol, text })

  validateEdit(lines, nextLines, { expectIds })

  const nextText = joinLines(nextLines, eol, trailingNewline || nextLines.length > 0)
  if (nextText === text) return { backup: null, changed: false }

  const backup = await writeBackup(path, text)
  await writePatchAtomic(path, nextText)
  return { backup, changed: true }
}
