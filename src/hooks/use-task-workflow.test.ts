import { act, renderHook, waitFor } from "@testing-library/react"
import { useTaskWorkflow } from "./use-task-workflow"

const mockQuery = vi.fn()
const mockLiveOf = vi.fn()
const mockDb = { query: mockQuery, liveOf: mockLiveOf }
let emit: (message: { value: unknown }) => void = () => {}

vi.mock("@components/surrealdb-provider", () => ({
  useSurrealDB: () => ({ db: mockDb, status: "connected" }),
}))

// Past the coalesce window for changes that touch only tasks of joined runs.
const EXPANDED_WINDOW = 2100

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
              expanded: [{ id: "task:other", workflow_id: "other" }],
              joinedIds: ["other"],
              walkedIds: ["other"],
              joinedTotal: 1,
            },
          ],
    )
    const { result } = renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(result.current.expanded).toHaveLength(1))
    expect(result.current.members.map((member) => member.id)).toEqual(["task:root"])

    act(() => emit({ value: { id: "task:other", workflow_id: "other" } }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPANDED_WINDOW)
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
              expanded: [],
              joinedIds: ["later"],
              walkedIds: ["later"],
              joinedTotal: 1,
            },
          ],
    )
    renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(mockLiveOf).toHaveBeenCalled())

    act(() => emit({ value: { id: "task:later", workflow_id: "other" } }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPANDED_WINDOW)
    })
    expect(snapshotCalls()).toBe(2)
  })

  it("refreshes when a task inside an expanded joined run changes", async () => {
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
              expanded: [
                { id: "task:other", workflow_id: "other", children: ["other-child"] },
                { id: "task:other-child", workflow_id: "other", parent_id: "other" },
              ],
              joinedIds: ["other"],
              walkedIds: ["other", "other-child"],
              joinedTotal: 1,
              expansionCut: 0,
            },
          ],
    )
    renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(mockLiveOf).toHaveBeenCalled())

    act(() => emit({ value: { id: "task:other-child", workflow_id: "other", parent_id: "other" } }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPANDED_WINDOW)
    })
    expect(snapshotCalls()).toBe(2)
  })

  it("refreshes when a nested child or join the walk reached is recorded after the snapshot", async () => {
    mockQuery.mockImplementation(async (query: string) =>
      query.startsWith("LIVE")
        ? ["live-uuid"]
        : [
            null,
            null,
            {
              task: { id: "task:root", workflow_id: "root", joined_tasks: ["run"] },
              workflow: null,
              members: [{ id: "task:root", workflow_id: "root", joined_tasks: ["run"] }],
              expanded: [
                { id: "task:run", workflow_id: "other", children: ["later-child"], joined_tasks: ["later-join"] },
              ],
              joinedIds: ["run"],
              walkedIds: ["run", "later-child", "later-join"],
              joinedTotal: 1,
              expansionCut: 0,
            },
          ],
    )
    renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(mockLiveOf).toHaveBeenCalled())

    for (const [index, id] of ["later-child", "later-join"].entries()) {
      act(() => emit({ value: { id: `task:${id}`, workflow_id: "other" } }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(EXPANDED_WINDOW)
      })
      expect(snapshotCalls()).toBe(index + 2)
    }
  })

  it("waits longer for changes that touch only joined-run tasks, but not once the workflow itself changes", async () => {
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
              expanded: [{ id: "task:other", workflow_id: "other" }],
              joinedIds: ["other"],
              walkedIds: ["other"],
              joinedTotal: 1,
            },
          ],
    )
    renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(mockLiveOf).toHaveBeenCalled())

    act(() => emit({ value: { id: "task:other", workflow_id: "other" } }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(snapshotCalls()).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPANDED_WINDOW - 1000)
    })
    expect(snapshotCalls()).toBe(2)

    // A member change while a joined-run refresh waits refreshes at the member pace.
    act(() => emit({ value: { id: "task:other", workflow_id: "other" } }))
    act(() => emit({ value: { id: "task:member", workflow_id: "root" } }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(snapshotCalls()).toBe(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPANDED_WINDOW)
    })
    expect(snapshotCalls()).toBe(3)
  })
})
