import { joinedRunsQuery, MAX_EXPANDED_TASKS, MAX_EXPANSION_DEPTH, MAX_JOINED_RUNS } from "./joined-runs"

describe("joinedRunsQuery", () => {
  const { statements, fields } = joinedRunsQuery()
  const statement = (name: string) => statements.find((candidate) => candidate.startsWith(`LET $${name} =`)) ?? ""

  it("chooses the first MAX_JOINED_RUNS non-member joined ids", () => {
    expect(statement("seen0")).toBe(`LET $seen0 = array::slice($joinedCandidates,0,${MAX_JOINED_RUNS})`)
    expect(statement("joinedCandidates")).toContain("array::complement(")
    expect(statement("joinedCandidates")).toContain("$links.task_id")
  })

  it("walks children and joined runs level by level, skipping seen tasks and members", () => {
    for (let level = 1; level <= MAX_EXPANSION_DEPTH; level++) {
      const next = statement(`next${level}`)
      expect(next).toContain(`$found${level - 1}.children`)
      expect(next).toContain(`$found${level - 1}.joined_tasks`)
      expect(next).toContain(`array::concat($seen${level - 1},$links.task_id)`)
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
