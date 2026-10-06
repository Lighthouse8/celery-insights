const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const buildTaskSearch = (query: string): { clause: string; bindings: Record<string, string> } => {
  const trimmed = query.trim()
  const keyword = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(trimmed)
  if (keyword) {
    const [, key, input] = keyword
    let value = input.trim()
    let pattern: string
    if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      pattern = escapeRegex(value)
    } else if (/^(true|false|none|null)$/i.test(value)) {
      pattern = /^(true|false)$/i.test(value) ? `(?i:${value.toLowerCase()})` : "(?:None|null)"
    } else {
      if (value.startsWith('"')) {
        try {
          const parsed: unknown = JSON.parse(value)
          if (typeof parsed === "string") value = parsed
        } catch {
          // An incomplete quoted value stays a literal search while typing.
        }
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1)
      }
      pattern = `['"]${escapeRegex(value)}['"]`
    }
    return {
      clause: "string::matches(kwargs ?? '', $kwargsPattern)",
      bindings: { kwargsPattern: `(?:^|[,{])\\s*['"]${escapeRegex(key)}['"]\\s*:\\s*${pattern}\\s*(?:[,}]|$)` },
    }
  }
  return {
    clause: [
      "string::concat('', id)",
      "type ?? ''",
      "worker ?? ''",
      "exception ?? ''",
      "result ?? ''",
      "args ?? ''",
      "kwargs ?? ''",
    ]
      .map((field) => `string::contains(string::lowercase(${field}), $query)`)
      .join(" OR "),
    bindings: { query: trimmed.toLowerCase() },
  }
}
