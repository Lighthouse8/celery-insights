import { act, renderHook, waitFor } from "@testing-library/react"
import type { SurrealTask } from "@/types/surreal-records"
import { applyProgressOnlyChange, useTaskWorkflow } from "./use-task-workflow"

const mockQuery = vi.fn()
const mockLiveOf = vi.fn()
const mockDb = { query: mockQuery, liveOf: mockLiveOf }
let emit: (message: { value: unknown }) => void = () => {}

vi.mock("@components/surrealdb-provider", () => ({
  useSurrealDB: () => ({ db: mockDb, status: "connected" }),
}))

const snapshotCalls = () => mockQuery.mock.calls.filter(([query]) => String(query).includes("LET $task")).length

describe("useTaskWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockQuery.mockImplementation(async (query: string) =>
      query.startsWith("LIVE")
        ? ["live-uuid"]
        : [null, null, { task: { id: "task:root", workflow_id: "root" }, workflow: null, members: [] }],
    )
    mockLiveOf.mockResolvedValue({
      subscribe: (callback: typeof emit) => {
        emit = callback
        return () => {}
      },
      kill: vi.fn().mockResolvedValue(undefined),
    })
  })
  afterEach(() => vi.useRealTimers())

  it("coalesces a burst of member notifications into one snapshot refresh", async () => {
    renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(mockLiveOf).toHaveBeenCalled())
    expect(snapshotCalls()).toBe(1)

    act(() => {
      for (let i = 0; i < 100; i++) emit({ value: { id: `task:member-${i}`, workflow_id: "root" } })
    })
    expect(snapshotCalls()).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(snapshotCalls()).toBe(2)
  })
})

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
