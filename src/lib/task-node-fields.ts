import { parseLiteral } from "./task-search"
import type { Task } from "@/types/surreal-records"

/** A task attribute (`type`, `worker`), a keyword argument (`kwargs.channel`) or a positional one (`args.0`). */
const FIELD_PATH = /^(?:[a-z_]+|kwargs\.[A-Za-z_][A-Za-z0-9_]*|args\.[0-9]+)$/

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
    if (!FIELD_PATH.test(field.path) || seen.has(field.path)) return false
    seen.add(field.path)
    return true
  })
}

export const invalidTaskNodeFields = (spec: string): string[] =>
  splitSpec(spec)
    .filter((field) => !FIELD_PATH.test(field.path))
    .map((field) => field.path)

const quotedEnd = (text: string, start: number): number => {
  for (let index = start + 1; index < text.length; index++)
    if (text[index] === "\\") index++
    else if (text[index] === text[start]) return index + 1
  return text.length
}

// Where a container item ends: a top-level comma, the container's close, or (for a dict key) a colon.
const itemEnd = (text: string, start: number, isKey: boolean): number => {
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (character === "'" || character === '"') index = quotedEnd(text, index) - 1
    else if ("([{".includes(character)) depth++
    else if (")]}".includes(character)) {
      if (!depth) return index
      depth--
    } else if (!depth && (character === "," || (isKey && character === ":"))) return index
  }
  return text.length
}

const displayValue = (raw: string): string => {
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
  if (!text || start < 0 || !"{[(".includes(text[start])) return items
  const isDictionary = text[start] === "{"
  for (let index = start + 1, position = 0; index < text.length && !")]}".includes(text[index]); position++) {
    let key = String(position)
    if (isDictionary) {
      const keyEnd = itemEnd(text, index, true)
      if (text[keyEnd] !== ":") break
      key = displayValue(text.slice(index, keyEnd).trim())
      index = keyEnd + 1
    }
    const end = itemEnd(text, index, false)
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
