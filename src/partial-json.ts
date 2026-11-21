/**
 * Tolerant parser for a JSON PREFIX, so the TUI can render a screen while
 * the model still streams it.
 *
 * `parsePartialJson('{"title":"Hel')` → `{ title: "Hel" }`.
 *
 * Rules at the cut point:
 * - an open string keeps its text so far (live typing effect);
 * - a key without a finished value is dropped;
 * - a half literal (`tru`, `nul`) or a lone `-` is dropped;
 * - open arrays and objects close implicitly.
 *
 * It never throws on a prefix. It throws only on text that no suffix can
 * make valid (for example `{]`), and returns `undefined` for blank input.
 */

/** Sentinel for "no value at the cut". A `unique symbol`, so it never collides with JSON. */
const MISSING: unique symbol = Symbol("missing")

class Cursor {
  i = 0
  constructor(readonly s: string) {}
  get eof(): boolean {
    return this.i >= this.s.length
  }
  peek(): string {
    return this.s[this.i] ?? ""
  }
  ws(): void {
    while (!this.eof && /\s/.test(this.s[this.i] as string)) this.i++
  }
  fail(what: string): never {
    throw new SyntaxError(`partial-json: ${what} at ${this.i}`)
  }
}

function parseString(c: Cursor): { value: string; closed: boolean } {
  c.i++ // opening quote
  let out = ""
  while (!c.eof) {
    const ch = c.s[c.i] as string
    if (ch === '"') {
      c.i++
      return { value: out, closed: true }
    }
    if (ch === "\\") {
      const next = c.s[c.i + 1]
      if (next === undefined) break // cut inside an escape: drop it
      if (next === "u") {
        const hex = c.s.slice(c.i + 2, c.i + 6)
        if (hex.length < 4) break
        out += String.fromCharCode(Number.parseInt(hex, 16))
        c.i += 6
        continue
      }
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }
      out += map[next] ?? next
      c.i += 2
      continue
    }
    out += ch
    c.i++
  }
  c.i = c.s.length
  return { value: out, closed: false }
}

function parseLiteral(c: Cursor): unknown {
  for (const [word, value] of [
    ["true", true],
    ["false", false],
    ["null", null],
  ] as const) {
    const rest = c.s.slice(c.i, c.i + word.length)
    if (rest === word) {
      c.i += word.length
      return value
    }
    if (word.startsWith(rest) && c.i + rest.length === c.s.length) {
      c.i = c.s.length
      return MISSING
    }
  }
  return c.fail("bad literal")
}

function parseNumber(c: Cursor): unknown {
  const start = c.i
  while (!c.eof && /[-+0-9.eE]/.test(c.peek())) c.i++
  const text = c.s.slice(start, c.i)
  if (c.eof) {
    // A number at the cut may still grow: "1" may become "12". Keep it only
    // when it parses; the next frame corrects it.
    const n = Number.parseFloat(text)
    return Number.isFinite(n) ? n : MISSING
  }
  const n = Number(text)
  if (!Number.isFinite(n)) c.fail("bad number")
  return n
}

function parseValue(c: Cursor): unknown {
  c.ws()
  if (c.eof) return MISSING
  const ch = c.peek()
  if (ch === "{") return parseObject(c)
  if (ch === "[") return parseArray(c)
  if (ch === '"') return parseString(c).value
  if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber(c)
  return parseLiteral(c)
}

function parseArray(c: Cursor): unknown[] {
  c.i++
  const out: unknown[] = []
  for (;;) {
    c.ws()
    if (c.eof) return out
    if (c.peek() === "]") {
      c.i++
      return out
    }
    const v = parseValue(c)
    if (v === MISSING) return out
    out.push(v)
    c.ws()
    if (c.eof) return out
    const sep = c.peek()
    if (sep === ",") c.i++
    else if (sep !== "]") c.fail("expected , or ]")
  }
}

function parseObject(c: Cursor): Record<string, unknown> {
  c.i++
  const out: Record<string, unknown> = {}
  for (;;) {
    c.ws()
    if (c.eof) return out
    if (c.peek() === "}") {
      c.i++
      return out
    }
    if (c.peek() !== '"') c.fail("expected key")
    const key = parseString(c)
    if (!key.closed) return out
    c.ws()
    if (c.eof) return out
    if (c.peek() !== ":") c.fail("expected :")
    c.i++
    const v = parseValue(c)
    if (v === MISSING) return out
    out[key.value] = v
    c.ws()
    if (c.eof) return out
    const sep = c.peek()
    if (sep === ",") c.i++
    else if (sep !== "}") c.fail("expected , or }")
  }
}

/** An opening markdown fence line: ```` ``` ```` or ```` ```json ````. */
const OPEN_FENCE = /```[a-zA-Z]*[ \t]*\r?\n/g

/**
 * The end (exclusive) of the JSON value that starts at `start`, or `-1` when
 * the text ends before it closes. The scan skips string contents (with
 * escapes), so a brace or a fence inside a string does not count.
 */
function valueEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === "\\") i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === "{" || ch === "[") depth++
    else if (ch === "}" || ch === "]") {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * Cut the JSON object out of what some models put around it, even in
 * structured-output mode: leading prose, a markdown fence, trailing prose.
 *
 * Candidate starts, in order: the first `{`, then the first `{` after each
 * opening fence. For each candidate:
 * - not closed yet (still streaming): return the rest of the text, for
 *   {@link parsePartialJson};
 * - closed and valid JSON: return exactly that object (trailing text cut);
 * - closed but not JSON (for example `{braces}` in prose): try the next.
 * When no candidate is valid JSON, return the first closed one, so the
 * caller's `JSON.parse` error names the real problem.
 *
 * Returns `""` when there is no `{`.
 */
export function extractJsonText(text: string): string {
  const starts = [text.indexOf("{")]
  if (starts[0] === -1) return ""
  for (const fence of text.matchAll(OPEN_FENCE)) {
    const s = text.indexOf("{", fence.index + fence[0].length)
    if (s > (starts.at(-1) ?? -1)) starts.push(s)
  }
  let fallback: string | undefined
  for (const start of starts) {
    const end = valueEnd(text, start)
    if (end < 0) return text.slice(start)
    const candidate = text.slice(start, end)
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      fallback ??= candidate
    }
  }
  return fallback as string
}

/** Parse a JSON prefix. See the module doc. */
export function parsePartialJson(text: string): unknown {
  const c = new Cursor(text)
  const v = parseValue(c)
  return v === MISSING ? undefined : v
}
