import type { SurrealTask } from "@/types/surreal-records"
import { applyProgressOnlyChange } from "./use-task-workflow"

const task = (id: string, overrides: Partial<SurrealTask> = {}): SurrealTask => ({
  id: `task:${id}`,
  state: "STARTED",
  last_updated: "2026-10-08T10:00:00Z",
  children: [],
  ...overrides,
})

const progress = { current: 3, total: 10, updated_at: "2026-10-08T10:00:05Z" }

describe("applyProgressOnlyChange", () => {
  const snapshot = { task: task("root"), workflow: null, members: [task("root"), task("child")] }

  it("patches a member whose only change is its progress", () => {
    const record = task("child", { progress })

    expect(applyProgressOnlyChange(snapshot, record)).toEqual({
      ...snapshot,
      members: [snapshot.members[0], record],
    })
  })

  it("patches the page's own task and its member row together", () => {
    const record = task("root", { progress })

    expect(applyProgressOnlyChange(snapshot, record)).toEqual({
      ...snapshot,
      task: record,
      members: [record, snapshot.members[1]],
    })
  })

  it("leaves any other change to a fresh snapshot", () => {
    expect(applyProgressOnlyChange(snapshot, task("child", { progress, state: "SUCCESS" }))).toBeUndefined()
    expect(applyProgressOnlyChange(snapshot, task("unknown", { progress }))).toBeUndefined()
  })
})
