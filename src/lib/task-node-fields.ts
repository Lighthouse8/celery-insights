import { parseLiteral } from "./task-search"
import type { Task } from "@/types/surreal-records"

// Scalar task attributes. Payload fields (args, kwargs, result, exception, traceback) are left out: their raw text
// doesn't fit a label, and arguments are reached one by one through kwargs.<name> and args.<index>.
export const TASK_NODE_ATTRIBUTES = [
  "id",
  "type",
  "state",
  "worker",
  "routing_key",
  "exchange",
  "retries",
  "runtime",
  "eta",
  "expires",
  "root_id",
  "parent_id",
]

const ARGUMENT_PATH = /^(?:kwargs\.[A-Za-z_][A-Za-z0-9_]*|args\.[0-9]+)$/

const isFieldPath = (path: string) => TASK_NODE_ATTRIBUTES.includes(path) || ARGUMENT_PATH.test(path)

// Label geometry under the 60px avatar, shared by the node and the graph's layout and bounds.
export const TASK_NODE_LABEL_WIDTH = 220
export const TASK_NODE_LABEL_LINE_HEIGHT = 14
export const TASK_NODE_LABEL_GAP = 4

export interface TaskNodeField {
  path: string
  alias?: string
}

const splitSpec = (spec: string) =>
  spec
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf(":")
      if (separator < 0) return { path: item }
      const alias = item.slice(separator + 1).trim()
      return { path: item.slice(0, separator).trim(), alias: alias || undefined }
    })

/** Comma-separated `path[:alias]` items; an alias replaces the field's name in its label. */
export const parseTaskNodeFields = (spec: string): TaskNodeField[] => {
  const seen = new Set<string>()
  return splitSpec(spec).filter((field) => {
    if (!isFieldPath(field.path) || seen.has(field.path)) return false
    seen.add(field.path)
    return true
  })
}

export const invalidTaskNodeFields = (spec: string): string[] =>
  splitSpec(spec)
    .filter((field) => !isFieldPath(field.path))
    .map((field) => field.path)

// Longer serialized arguments (full kwargs from the result backend, or a custom argsrepr; Celery's own stops at 1 KiB)
// are read up to here, as if cut. That bounds the work per node: 64 KiB takes several milliseconds to split.
const MAX_REPR_LENGTH = 8_192

// Where each quoted string may close. JSON and repr escape every quote inside double quotes. Celery's saferepr
// writes backslashes raw and escapes only ', so in single quotes `\'` is either an escaped quote or a string
// ending in a backslash ('C:\'): every `\'` up to the first bare quote is a candidate. In cut text with no bare
// quote after the start, the string may also close past the cut, read as running to the end.
const closeCandidates = (text: string, start: number, cut: boolean): number[] => {
  if (text[start] === '"') {
    for (let index = start + 1; index < text.length; index++)
      if (text[index] === "\\") index++
      else if (text[index] === '"') return [index + 1]
    return []
  }
  const candidates: number[] = []
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] !== "'") continue
    candidates.push(index + 1)
    if (text[index - 1] !== "\\") return candidates
  }
  if (cut && candidates.at(-1) !== text.length) candidates.push(text.length)
  return candidates
}

// saferepr writes bytes (b'it's') and custom reprs (<Opaque it's>) as they are, quotes unescaped. Like search's
// lenient pattern, such a value after a delimiter runs to the first close that a delimiter (or the end) follows, as
// long as the rest of the text splits from there and no value of the same kind opens before it; otherwise its end is
// ambiguous. In cut text with no such close it runs past the cut. Returns that close when start opens such a value.
const opaqueClose = (text: string, start: number): string | undefined => {
  const character = text[start]
  const bytes = (character === "'" || character === '"') && text[start - 1] === "b"
  if (character !== "<" && !bytes) return undefined
  let before = (bytes ? start - 1 : start) - 1
  while (before >= 0 && /\s/.test(text[before])) before--
  return before >= 0 && ":,[({".includes(text[before]) ? (bytes ? character : ">") : undefined
}

// Sticky: matches at lastIndex when a delimiter or the end of the text follows, past any spaces.
const DELIMITED = /\s*(?:[,:)\]}]|$)/y

/**
 * Where each quoted string ends, or -1 when its end is ambiguous. A candidate close qualifies when a delimiter
 * (or the end) follows it and the rest of the text splits into quoted strings, opaque values and plain characters
 * without a backslash outside a string, under one of two readings: bytes and `<…>` as opaque values running to any
 * close a delimiter follows, or as plain text. In saferepr's text the real close qualifies whenever every later bytes
 * or `<…>` value follows a delimiter and closes before any cut, so exactly one qualifying candidate is the end. With
 * several, saferepr could have written the text from different arguments; with none, the text isn't saferepr's (or
 * is one of those exceptions), and any pick is a guess.
 */
const quotedStrings = (text: string, cut: boolean) => {
  // splits[index]: the text from index on splits; clean[index]: it splits with bytes read as plain strings and <
  // as a plain character; opaqueEnds[index]: where an opaque value opened there ends, or -1 when that's ambiguous.
  // One right-to-left pass fills all three, so a reading looks up the readings
  // after it rather than recursing through every later string (a stack frame each), and it tracks closeCandidates'
  // ends as it goes rather than rescanning them per quote (quadratic on a run of `\'`).
  let tables: { splits: boolean[]; clean: boolean[]; opaqueEnds: number[] } | undefined
  const fillTables = () => {
    const splits: boolean[] = []
    const clean: boolean[] = []
    const opaqueEnds: number[] = []
    // Where a double-quoted string read from index closes, outside an escape.
    const doubleClose: number[] = []
    // Whether a single-quoted string opened before the nearest ' has a candidate end from there on that splits
    // (cleanly). In cut text a string may close past the cut.
    let singleSplits = cut
    let singleClean = cut
    // After index: the nearest non-space character, where the nearest close of each kind that a delimiter follows
    // ends, whether any such close leaves text that splits, and where the nearest opaque value of each kind opens.
    let solid = text.length
    const delimitedEnds: Record<string, number | undefined> = {}
    const delimitedSplits: Record<string, boolean | undefined> = {}
    const openers: Record<string, number | undefined> = {}
    splits[text.length] = clean[text.length] = true
    for (let index = text.length - 1; index >= 0; index--) {
      const character = text[index]
      const close = opaqueClose(text, index)
      const opaqueEnd = close ? delimitedEnds[close] : undefined
      doubleClose[index] =
        character === '"' ? index : character === "\\" ? doubleClose[index + 2] : doubleClose[index + 1]
      if (character === "'") {
        splits[index] = singleSplits
        clean[index] = singleClean
        const escaped = text[index - 1] === "\\"
        singleSplits = splits[index + 1] || (escaped && singleSplits)
        singleClean = clean[index + 1] || (escaped && singleClean)
      } else if (character === '"') {
        const end = doubleClose[index + 1]
        splits[index] = end === undefined ? cut : splits[end + 1]
        clean[index] = end === undefined ? cut : clean[end + 1]
      } else {
        // saferepr only writes a backslash inside a string, so one outside every string rejects the reading.
        splits[index] = character !== "\\" && splits[index + 1]
        clean[index] = character !== "\\" && clean[index + 1]
      }
      if (close && opaqueEnd === undefined && cut) {
        splits[index] = true
        opaqueEnds[index] = text.length
      } else if (close && opaqueEnd !== undefined) {
        splits[index] = delimitedSplits[close]!
        // An inner value of the same kind (<Foo [<Bar>]>) may own the first close; the close itself may read as a
        // bytes opener (b', ).
        const nested = (openers[close] ?? text.length) < opaqueEnd - 1
        opaqueEnds[index] = splits[opaqueEnd] && !nested ? opaqueEnd : -1
      }
      if ("'\">".includes(character) && (solid === text.length || ",:)]}".includes(text[solid]))) {
        delimitedEnds[character] = index + 1
        delimitedSplits[character] ||= splits[index + 1]
      }
      if (!/\s/.test(character)) solid = index
      if (close) openers[close] = index
    }
    return { splits, clean, opaqueEnds }
  }
  return (start: number): number => {
    const opaqueEnd = opaqueClose(text, start) && (tables ??= fillTables()).opaqueEnds[start]
    if (opaqueEnd) return opaqueEnd
    if (text[start] === "<") return start + 1
    const candidates = closeCandidates(text, start, cut)
    // Without a backslash every string has one end.
    if (candidates.length < 2) return candidates[0] ?? text.length
    const { splits, clean } = (tables ??= fillTables())
    const delimited = (end: number) => ((DELIMITED.lastIndex = end), DELIMITED.test(text))
    const qualifying = candidates.filter((end) => (clean[end] || splits[end]) && delimited(end))
    return qualifying.length === 1 ? qualifying[0] : -1
  }
}

// Where a container item ends: a top-level comma, the container's close, or (for a dict key) a colon. -1 when a
// string in it has an ambiguous end.
const itemEnd = (text: string, start: number, isKey: boolean, quotedEnd: (start: number) => number): number => {
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (character === "'" || character === '"' || character === "<") {
      const end = quotedEnd(index)
      if (end < 0) return -1
      index = end - 1
    } else if ("([{".includes(character)) depth++
    else if (")]}".includes(character)) {
      if (!depth) return index
      depth--
    } else if (!depth && (character === "," || (isKey && character === ":"))) return index
  }
  return text.length
}

// A single-quoted string with a backslash has no single decoding (saferepr leaves backslashes raw, repr escapes
// them), so it shows as written.
const displayValue = (raw: string): string => {
  if (raw.length > 1 && raw[0] === "'" && raw.endsWith("'") && raw.includes("\\")) return raw.slice(1, -1)
  const literal = raw[0] === "'" || raw[0] === '"' ? parseLiteral(raw, 0) : undefined
  return literal?.value[0] === "string" && literal.end === raw.length ? literal.value[1] : raw
}

/**
 * The top-level items of serialized args or kwargs, keyed by name or position, as display text. Celery cuts
 * the text at 1 KiB and writes `...` for what it left out, and values can be reprs no literal parser reads
 * (`datetime.date(2024, 1, 2)`), so each item is split out by its delimiters and shown as written.
 */
export const reprItems = (fullText: string | undefined): Map<string, string> => {
  const items = new Map<string, string>()
  const cut = (fullText?.length ?? 0) > MAX_REPR_LENGTH
  const text = cut ? fullText!.slice(0, MAX_REPR_LENGTH) : fullText
  const start = text?.search(/\S/) ?? -1
  if (!text || start < 0 || !"{[(".includes(text[start])) return items
  const quoted = quotedStrings(text, cut)
  // Bytes and <…> values end at a guessed close. When the text after them breaks the container's grammar, the guess
  // was wrong somewhere, so the labels from the first item with such a value on are dropped.
  let opaque = false
  let guessedFrom: number | undefined
  let wellFormed = true
  const quotedEnd = (index: number) => ((opaque ||= opaqueClose(text, index) !== undefined), quoted(index))
  const isDictionary = text[start] === "{"
  let index = start + 1
  for (let position = 0; index < text.length && !")]}".includes(text[index]); position++) {
    opaque = false
    let key = String(position)
    if (isDictionary) {
      const keyEnd = itemEnd(text, index, true, quotedEnd)
      if (text[keyEnd] !== ":") {
        // Past the last item, or a cut or ambiguous key; anything else is a positional item inside a dict.
        const rest = text.slice(index, keyEnd).trim()
        wellFormed = keyEnd < 0 || keyEnd === text.length || (")]}".includes(text[keyEnd]) && (!rest || rest === "..."))
        break
      }
      key = displayValue(text.slice(index, keyEnd).trim())
      index = keyEnd + 1
    }
    const end = itemEnd(text, index, false, quotedEnd)
    // An ambiguous item hides where every later item starts, so it ends the read like a cut.
    if (end < 0) break
    const raw = text.slice(index, end).trim()
    // Nothing before the close: an empty container (`[ ]`) or a trailing comma (`(7, )`).
    // An item that runs to the cut may continue past it.
    if (!raw || raw === "..." || (cut && end === text.length)) break
    if (opaque) guessedFrom ??= items.size
    if (!items.has(key)) items.set(key, displayValue(raw))
    index = text[end] === "," ? end + 1 : end
  }
  // The container closes with its own bracket.
  if (index < text.length && ")]}".includes(text[index]) && text[index] !== "}])"["{[(".indexOf(text[start])])
    wellFormed = false
  return wellFormed || guessedFrom === undefined ? items : new Map([...items].slice(0, guessedFrom))
}

export interface TaskNodeLabel {
  path: string
  text: string
  /** The untruncated value, for a hover title. */
  title: string
}

const attributeValue = (task: Task, path: string): string | undefined => {
  const value = (task as unknown as Record<string, unknown>)[path]
  if (typeof value === "string") return value || undefined
  return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined
}

/** One line per field the task has, in field order; a field the task lacks (or can't show) gets none. */
export const taskNodeLabels = (task: Task, fields: TaskNodeField[]): TaskNodeLabel[] => {
  const parsed: Partial<Record<"args" | "kwargs", Map<string, string>>> = {}
  return fields.flatMap(({ path, alias }) => {
    const dot = path.indexOf(".")
    if (dot < 0) {
      const value = attributeValue(task, path)
      if (value === undefined) return []
      // Task names are dotted module paths; the last part names the task, the tooltip keeps the rest.
      const shown = path === "type" ? value.slice(value.lastIndexOf(".") + 1) : value
      return [{ path, text: alias ? `${alias}=${shown}` : shown, title: value }]
    }
    const source = path.slice(0, dot) as "args" | "kwargs"
    const key = path.slice(dot + 1)
    const value = (parsed[source] ??= reprItems(task[source])).get(key)
    if (value === undefined) return []
    const name = alias ?? (source === "args" ? `args[${key}]` : key)
    return [{ path, text: `${name}=${value}`, title: value }]
  })
}
