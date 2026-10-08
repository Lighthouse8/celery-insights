import { act, renderHook, waitFor } from "@testing-library/react"
import type { SurrealTask } from "@/types/surreal-records"
import { applyProgressOnlyChange, keepNewerProgress, useTaskWorkflow } from "./use-task-workflow"

const mockDb = vi.hoisted(() => ({
  current: {} as { query: ReturnType<typeof vi.fn>; liveOf: ReturnType<typeof vi.fn> },
}))

vi.mock("@components/surrealdb-provider", () => ({
  useSurrealDB: () => ({ db: mockDb.current, status: "connected" }),
}))

const task = (id: string, overrides: Partial<SurrealTask> = {}): SurrealTask => ({
  id: `task:${id}`,
  state: "STARTED",
  last_updated: "2026-10-08T10:00:00Z",
  workflow_id: "root",
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

  it("matches a live record whose keys come in another order", () => {
    const { progress: _progress, ...fields } = task("child", { progress })
    const reordered = Object.fromEntries(Object.entries({ ...fields, progress }).reverse()) as unknown as SurrealTask

    expect(applyProgressOnlyChange(snapshot, reordered)?.members[1]).toBe(reordered)
  })

  it("leaves any other change to a fresh snapshot", () => {
    expect(applyProgressOnlyChange(snapshot, task("child", { progress, state: "SUCCESS" }))).toBeUndefined()
    expect(applyProgressOnlyChange(snapshot, task("unknown", { progress }))).toBeUndefined()
  })
})

describe("keepNewerProgress", () => {
  const known = { task: null, workflow: null, members: [task("child", { progress })] }

  it("keeps a report newer than the fresh snapshot's", () => {
    const stale = {
      task: null,
      workflow: null,
      members: [task("child", { progress: { ...progress, current: 2, updated_at: "2026-10-08T10:00:01Z" } })],
    }

    expect(keepNewerProgress(stale, known).members[0].progress).toEqual(progress)
  })

  it("takes the fresh snapshot's report when it is newer", () => {
    const newer = { ...progress, current: 4, updated_at: "2026-10-08T10:00:09Z" }
    const fresh = { task: null, workflow: null, members: [task("child", { progress: newer })] }

    expect(keepNewerProgress(fresh, known).members[0].progress).toEqual(newer)
  })

  it("orders reports and retry starts within the same millisecond", () => {
    const sameMillisecond = {
      task: null,
      workflow: null,
      members: [task("child", { progress: { ...progress, updated_at: "2026-10-08T10:00:05.000900Z" } })],
    }
    const olderInSameMillisecond = { ...progress, current: 2, updated_at: "2026-10-08T10:00:05.000100Z" }
    const stale = { task: null, workflow: null, members: [task("child", { progress: olderInSameMillisecond })] }
    const retriedLater = {
      task: null,
      workflow: null,
      members: [task("child", { last_started_at: "2026-10-08T10:00:05.000950Z" })],
    }

    expect(keepNewerProgress(stale, sameMillisecond).members[0].progress?.updated_at).toBe(
      "2026-10-08T10:00:05.000900Z",
    )
    expect(keepNewerProgress(retriedLater, sameMillisecond).members[0].progress).toBeUndefined()
  })

  it("never brings back progress from before a retry started", () => {
    const retried = {
      task: null,
      workflow: null,
      members: [task("child", { last_started_at: "2026-10-08T10:00:06Z" })],
    }

    expect(keepNewerProgress(retried, known).members[0].progress).toBeUndefined()
  })
})

describe("useTaskWorkflow", () => {
  it("keeps a progress report that arrives while an older snapshot is loading", async () => {
    let emit: (message: { action: string; value: unknown }) => void = () => {}
    let resolveSlowSnapshot: (value: unknown) => void = () => {}
    const snapshotResult = (child: SurrealTask) => [
      null,
      null,
      { task: task("root"), workflow: null, members: [task("root"), child] },
    ]
    const query = vi
      .fn()
      .mockResolvedValueOnce(
        snapshotResult(task("child", { progress: { ...progress, current: 2, updated_at: "2026-10-08T10:00:01Z" } })),
      )
      .mockResolvedValueOnce(["live-uuid"])
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSlowSnapshot = resolve)))
    mockDb.current = {
      query,
      liveOf: vi.fn().mockResolvedValue({
        subscribe: (callback: typeof emit) => {
          emit = callback
          return () => {}
        },
        kill: vi.fn().mockResolvedValue(undefined),
      }),
    }

    const { result } = renderHook(() => useTaskWorkflow("root"))
    await waitFor(() => expect(mockDb.current.liveOf).toHaveBeenCalled())

    // A state change starts a snapshot that read the child before its next report.
    act(() => emit({ action: "UPDATE", value: task("root", { state: "SUCCESS" }) }))
    act(() => emit({ action: "UPDATE", value: task("child", { progress }) }))
    await act(async () => {
      resolveSlowSnapshot(
        snapshotResult(task("child", { progress: { ...progress, current: 2, updated_at: "2026-10-08T10:00:01Z" } })),
      )
    })

    await waitFor(() => expect(result.current.members[1]?.progress).toEqual(progress))
  })
})

describe("keepNewerProgress across retries", () => {
  const known = (report: SurrealTask["progress"]) => ({
    task: null,
    workflow: null,
    members: [task("child", { progress: report })],
  })
  const fresh = (overrides: Partial<SurrealTask>) => ({
    task: null,
    workflow: null,
    members: [task("child", overrides)],
  })

  it("keeps a retry's cleared progress cleared", () => {
    const report = { ...progress, updated_at: "2026-10-08T10:00:20Z" }
    const retried = fresh({ state: "RETRY", last_updated: "2026-10-08T10:00:21Z" })

    expect(keepNewerProgress(retried, known(report)).members[0].progress).toBeUndefined()
  })

  it("orders reports by attempt, not by worker clocks", () => {
    const failedAttempt = { ...progress, attempt: 0, updated_at: "2026-10-08T10:00:30Z" }
    const nextAttempt = fresh({ retries: 1, progress: { ...progress, attempt: 1, updated_at: "2026-10-08T10:00:25Z" } })

    expect(keepNewerProgress(nextAttempt, known(failedAttempt)).members[0].progress?.attempt).toBe(1)
    expect(keepNewerProgress(fresh({ retries: 1 }), known(failedAttempt)).members[0].progress).toBeUndefined()
  })
})
