import { joinedRunIds, MAX_JOINED_RUNS } from "./joined-runs"

describe("joinedRunIds", () => {
  it("lists distinct non-member joined runs in id order, capped, with the full count", () => {
    const outside = Array.from({ length: MAX_JOINED_RUNS + 5 }, (_, index) => `run-${String(index).padStart(3, "0")}`)
    const tasks = [
      { id: "a", joined_tasks: [...outside].reverse() },
      { id: "b", joined_tasks: ["run-000", "a"] },
      { id: "c", joined_tasks: null },
    ]

    expect(joinedRunIds(tasks)).toEqual({ ids: outside.slice(0, MAX_JOINED_RUNS), total: outside.length })
  })
})
