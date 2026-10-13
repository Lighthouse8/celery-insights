import { MAX_EXPANSION_DEPTH } from "../../src/lib/joined-runs"
import { buildRead } from "./queries"

describe("task-workflow read", () => {
  const { sql } = buildRead({ operation: "task-workflow", taskId: "t" })

  it("selects from the task table only for the members, the joined-run links and indexed children lookups", () => {
    // Under a restricted scope each other FROM task becomes a projection of the whole task table.
    expect(sql.match(/\bFROM task\b(?! WHERE parent_id IN \$parents\d+ LIMIT)/g)).toHaveLength(2)
    expect(sql.match(/\bFROM task WHERE parent_id IN \$parents\d+ LIMIT/g)).toHaveLength(MAX_EXPANSION_DEPTH + 1)
  })

  it("expands joined runs by point reads, one lookup per walk level and one member check", () => {
    const pointReads = sql.match(/FROM type::record\('task',\$id\)/g) ?? []
    expect(pointReads).toHaveLength(MAX_EXPANSION_DEPTH + 2)
    expect(sql).toContain("array::map($seen0,")
    for (let level = 1; level <= MAX_EXPANSION_DEPTH; level++) expect(sql).toContain(`array::map($take${level},`)
  })
})
