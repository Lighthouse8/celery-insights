import { buildRead } from "./queries"

describe("task-workflow read", () => {
  it("reads the workflow's tasks once beyond the members and looks up only the chosen joined runs", () => {
    const { sql } = buildRead({ operation: "task-workflow", taskId: "t" })

    // Under a restricted scope each FROM task becomes a projection of the task table.
    expect(sql.match(/\bFROM task\b/g)).toHaveLength(2)
    expect(sql).toContain("array::map($joinedIds,")
    expect(sql).toContain("joinedIds:$joinedIds,joinedTotal:array::len($joinedCandidates)")
  })
})
