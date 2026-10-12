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
// Clears the progress bar drawn just under running tasks.
export const TASK_NODE_LABEL_GAP = 12

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

// Longer serialized arguments get no labels: the split below recurses once per quoted string.
const MAX_REPR_LENGTH = 8_192

// Where each quoted string may close. JSON and repr escape every quote inside double quotes. Celery's saferepr
// writes backslashes raw and escapes only ', so in single quotes `\'` is either an escaped quote or a string
// ending in a backslash ('C:\'): every `\'` up to the first bare quote is a candidate.
const closeCandidates = (text: string, start: number): number[] => {
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
    if (text[index - 1] !== "\\") break
  }
  return candidates
}

/**
 * Picks each quoted string's end the way the search matcher does: the first candidate after which the rest of
 * the text still splits into quoted strings and plain characters without a backslash. Text no reading splits
 * (bytes or a custom __repr__ with a stray quote) takes the first candidate.
 */
const quotedStrings = (text: string) => {
  const splits = new Map<number, boolean>()
  const splitsFrom = (start: number): boolean => {
    const quote = /['"]/g
    quote.lastIndex = start
    const next = quote.exec(text)
    // saferepr only writes a backslash inside a string, so one outside every string rejects the reading.
    if (text.slice(start, next?.index).includes("\\")) return false
    if (!next) return true
    const known = splits.get(start)
    if (known !== undefined) return known
    const result = closeCandidates(text, next.index).some(splitsFrom)
    splits.set(start, result)
    return result
  }
  return (start: number): number => {
    const candidates = closeCandidates(text, start)
    // Without a backslash every string has one end.
    if (candidates.length < 2) return candidates[0] ?? text.length
    return candidates.find(splitsFrom) ?? candidates[0]
  }
}

// Where a container item ends: a top-level comma, the container's close, or (for a dict key) a colon.
const itemEnd = (text: string, start: number, isKey: boolean, quotedEnd: (start: number) => number): number => {
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (character === "'" || character === '"') index = quotedEnd(index) - 1
    else if ("([{".includes(character)) depth++
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
export const reprItems = (text: string | undefined): Map<string, string> => {
  const items = new Map<string, string>()
  const start = text?.search(/\S/) ?? -1
  if (!text || start < 0 || text.length > MAX_REPR_LENGTH || !"{[(".includes(text[start])) return items
  const quotedEnd = quotedStrings(text)
  const isDictionary = text[start] === "{"
  for (let index = start + 1, position = 0; index < text.length && !")]}".includes(text[index]); position++) {
    let key = String(position)
    if (isDictionary) {
      const keyEnd = itemEnd(text, index, true, quotedEnd)
      if (text[keyEnd] !== ":") break
      key = displayValue(text.slice(index, keyEnd).trim())
      index = keyEnd + 1
    }
    const end = itemEnd(text, index, false, quotedEnd)
    const raw = text.slice(index, end).trim()
    if (raw === "...") break
    if (!items.has(key)) items.set(key, displayValue(raw))
    index = text[end] === "," ? end + 1 : end
  }
  return items
}

export interface TaskNodeLabel {
  path: string
  text: string
  /** The untruncated value, for a hover title. */
  title: string
}

const attributeValue = (task: Task, path: string): string | undefined => {
  const value = (task as unknown as Record<string, unknown>)[path]
  if (value instanceof Date) return value.toLocaleString()
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
