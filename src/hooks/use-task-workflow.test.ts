import { act, renderHook, waitFor } from "@testing-library/react"
import { useTaskWorkflow } from "./use-task-workflow"

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

  it("ignores a snapshot that resolves after a newer one", async () => {
    const snapshot = (state: string) => [null, null, { task: { id: "task:root", state }, workflow: null, members: [] }]
    const pending: Array<(value: unknown) => void> = []
    const { result } = renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(mockLiveOf).toHaveBeenCalled())
    mockQuery.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))

    act(() => emit({ value: { __observation_refresh: true } }))
    act(() => emit({ value: { __observation_refresh: true } }))
    expect(pending).toHaveLength(2)

    await act(async () => pending[1](snapshot("SUCCESS")))
    await act(async () => pending[0](snapshot("STARTED")))

    expect(result.current.task?.state).toBe("SUCCESS")
  })

  it("returns joined runs apart from the members and refreshes when one changes", async () => {
    mockQuery.mockImplementation(async (query: string) =>
      query.startsWith("LIVE")
        ? ["live-uuid"]
        : [
            null,
            null,
            {
              task: { id: "task:root", workflow_id: "root", joined_tasks: ["other"] },
              workflow: null,
              members: [{ id: "task:root", workflow_id: "root", joined_tasks: ["other"] }],
              joined: [{ id: "task:other", workflow_id: "other" }],
              joinedIds: ["other"],
              joinedTotal: 1,
            },
          ],
    )
    const { result } = renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(result.current.joined).toHaveLength(1))
    expect(result.current.members.map((member) => member.id)).toEqual(["task:root"])

    act(() => emit({ value: { id: "task:other", workflow_id: "other" } }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(snapshotCalls()).toBe(2)
  })

  it("refreshes when a joined run the read chose first gets a row", async () => {
    mockQuery.mockImplementation(async (query: string) =>
      query.startsWith("LIVE")
        ? ["live-uuid"]
        : [
            null,
            null,
            {
              task: { id: "task:root", workflow_id: "root" },
              workflow: null,
              // The member that joined "later" is older than the members the read returns.
              members: [{ id: "task:root", workflow_id: "root" }],
              joined: [],
              joinedIds: ["later"],
              joinedTotal: 1,
            },
          ],
    )
    renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(mockLiveOf).toHaveBeenCalled())

    act(() => emit({ value: { id: "task:later", workflow_id: "other" } }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(snapshotCalls()).toBe(2)
  })
})
