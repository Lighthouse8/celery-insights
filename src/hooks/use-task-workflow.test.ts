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

  it("applies each overlapping snapshot that resolves in order", async () => {
    const snapshot = (state: string) => [null, null, { task: { id: "task:root", state }, workflow: null, members: [] }]
    const pending: Array<(value: unknown) => void> = []
    const { result } = renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(mockLiveOf).toHaveBeenCalled())
    mockQuery.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))

    // A slow query under a steady update stream: each response lands after the next request started.
    act(() => emit({ value: { __observation_refresh: true } }))
    act(() => emit({ value: { __observation_refresh: true } }))
    await act(async () => pending[0](snapshot("STARTED")))
    expect(result.current.task?.state).toBe("STARTED")

    act(() => emit({ value: { __observation_refresh: true } }))
    await act(async () => pending[1](snapshot("RETRY")))
    expect(result.current.task?.state).toBe("RETRY")
    await act(async () => pending[2](snapshot("SUCCESS")))
    expect(result.current.task?.state).toBe("SUCCESS")
  })

  it("ignores a snapshot for the previous task id", async () => {
    const pending: Array<(value: unknown) => void> = []
    const { result, rerender } = renderHook(({ taskId }) => useTaskWorkflow(taskId), {
      initialProps: { taskId: "root" },
    })
    await waitFor(() => expect(mockLiveOf).toHaveBeenCalled())
    mockQuery.mockImplementation((query: string) =>
      query.startsWith("LIVE") ? Promise.resolve(["live-uuid"]) : new Promise((resolve) => pending.push(resolve)),
    )

    act(() => emit({ value: { __observation_refresh: true } }))
    rerender({ taskId: "other" })
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(result.current.isLoading).toBe(true)
    await act(async () => pending[0]([null, null, { task: { id: "task:root", state: "STALE" }, workflow: null }]))
    expect(result.current.task?.state).toBeUndefined()
    expect(result.current.isLoading).toBe(true)
    await act(async () => pending[1]([null, null, { task: { id: "task:other" }, workflow: null, members: [] }]))
    expect(result.current.task?.id).toBe("task:other")
    expect(result.current.isLoading).toBe(false)
  })
})
