import { MAX_EXPANSION_DEPTH } from "../../src/lib/joined-runs"
import { buildRead } from "./queries"

describe("task-workflow read", () => {
  const { sql } = buildRead({ operation: "task-workflow", taskId: "t" })

  it("selects from the task table only for the members and once for the joined-run links", () => {
    // Under a restricted scope each FROM task becomes a projection of the whole task table.
    expect(sql.match(/\bFROM task\b/g)).toHaveLength(2)
  })

  it("expands joined runs by point reads only, one lookup per walk level", () => {
    const pointReads = sql.match(/FROM type::record\('task',\$id\)/g) ?? []
    expect(pointReads).toHaveLength(MAX_EXPANSION_DEPTH + 1)
    expect(sql).toContain("array::map($seen0,")
    for (let level = 1; level <= MAX_EXPANSION_DEPTH; level++) expect(sql).toContain(`array::map($take${level},`)
  })
})
