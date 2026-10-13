import {
  joinedRunsQuery,
  MAX_EXPANDED_TASKS,
  MAX_EXPANSION_DEPTH,
  MAX_JOINED_RUNS,
  MAX_LINKING_MEMBERS,
} from "./joined-runs"

describe("joinedRunsQuery", () => {
  const { statements, fields } = joinedRunsQuery()
  const statement = (name: string) => statements.find((candidate) => candidate.startsWith(`LET $${name} =`)) ?? ""

  it("takes at most MAX_LINKING_MEMBERS joining members' links, by index and unordered, and flags more", () => {
    expect(statement("linkRows")).toContain("WHERE joined_workflow_id = $workflowId ")
    expect(statement("linkRows")).toContain(` LIMIT ${MAX_LINKING_MEMBERS + 1} `)
    expect(statement("linkRows")).not.toContain("ORDER BY")
    expect(statement("links")).toBe(`LET $links = array::slice($linkRows,0,${MAX_LINKING_MEMBERS})`)
    expect(fields).toContain(`membersCut:array::len($linkRows) > ${MAX_LINKING_MEMBERS}`)
  })

  it("chooses the first MAX_JOINED_RUNS non-member joined ids", () => {
    expect(statement("seen0")).toBe(`LET $seen0 = array::slice($joinedCandidates,0,${MAX_JOINED_RUNS})`)
    expect(statement("linked")).toContain("$links.task_id")
    expect(statement("memberJoins")).toContain(") TIMEOUT 2s)[0] = $workflowId)")
    expect(statement("joinedCandidates")).toBe("LET $joinedCandidates = array::complement($linked,$memberJoins)")
  })

  it("walks children, joined runs and children by parent_id level by level, skipping seen tasks and members", () => {
    for (let level = 1; level <= MAX_EXPANSION_DEPTH; level++) {
      const next = statement(`next${level}`)
      expect(next).toContain(`$found${level - 1}.children`)
      expect(next).toContain(`$found${level - 1}.joined_tasks`)
      expect(next).toContain(`$byParent${level}`)
      expect(next).toContain(`array::concat($seen${level - 1},$skip)`)
      expect(statement(`byParent${level}`)).toContain(`FROM task WHERE parent_id IN $parents${level} LIMIT `)
      expect(statement(`found${level}`)).toContain(`$task.parent_id IN $expandedIds${level - 1}`)
    }
    expect(statement(`next${MAX_EXPANSION_DEPTH + 1}`)).toBe("")
  })

  it("never reads more than MAX_EXPANDED_TASKS tasks and counts what it leaves out", () => {
    for (let level = 1; level <= MAX_EXPANSION_DEPTH; level++)
      expect(statement(`take${level}`)).toContain(
        `math::max([0,${MAX_EXPANDED_TASKS} - array::len($seen${level - 1})])`,
      )
    expect(fields).toContain(`array::complement($next${MAX_EXPANSION_DEPTH},$take${MAX_EXPANSION_DEPTH})`)
    expect(fields).toContain("$beyond")
  })
})
