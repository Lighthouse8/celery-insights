import { extractId, parseTask, type SurrealTask } from "./surreal-records"

describe("extractId", () => {
  it("extracts plain IDs from table-prefixed record IDs", () => {
    expect(extractId("task:abc-123")).toBe("abc-123")
    expect(extractId("worker:celery@worker-1")).toBe("celery@worker-1")
  })

  it("strips angle-bracket-wrapped IDs from Surreal serialization", () => {
    expect(extractId("task:<abc-123>")).toBe("abc-123")
    expect(extractId("task:⟨abc-123⟩")).toBe("abc-123")
  })

  it("strips quoted IDs from Surreal serialization", () => {
    expect(extractId("task:'abc-123'")).toBe("abc-123")
    expect(extractId('task:"abc-123"')).toBe("abc-123")
  })
})

describe("parseTask progress", () => {
  const raw: SurrealTask = { id: "task:abc", state: "STARTED", last_updated: "2025-06-15T12:00:00Z", children: [] }

  it("leaves progress undefined when the task never reported any", () => {
    expect(parseTask(raw).progress).toBeUndefined()
    expect(parseTask({ ...raw, progress: null }).progress).toBeUndefined()
  })

  it("hides a report from an attempt before the current one, using retries on rows without highest_retries", () => {
    const report = { current: 3, total: 10, updated_at: "2025-06-15T12:00:05Z", attempt: 0 }

    expect(parseTask({ ...raw, retries: 1, progress: report }).progress).toBeUndefined()
    expect(parseTask({ ...raw, retries: 0, progress: report }).progress?.current).toBe(3)
  })

  it("orders reports by the highest retry count seen, not the shown one", () => {
    const report = { current: 3, total: 10, updated_at: "2025-06-15T12:00:05Z", attempt: 1 }
    const task = parseTask({ ...raw, retries: 0, highest_retries: 2, progress: report })

    expect(task.retries).toBe(0)
    expect(task.progress).toBeUndefined()
  })

  it("parses sections outermost first, dropping empty optional fields", () => {
    const task = parseTask({
      ...raw,
      progress: {
        current: 1,
        total: 2,
        updated_at: "2025-06-15T12:00:05Z",
        sections: [
          { description: "Days", current: 4, total: 10 },
          { description: "", current: 2, total: null },
        ],
      },
    })
    expect(task.progress?.sections).toEqual([{ description: "Days", current: 4, total: 10 }, { current: 2 }])
  })

  it("parses reported progress and drops empty optional fields", () => {
    const task = parseTask({
      ...raw,
      progress: { current: 3, total: null, description: "", updated_at: "2025-06-15T12:00:05Z" },
    })
    expect(task.progress).toEqual({ current: 3, updated_at: new Date("2025-06-15T12:00:05Z"), sections: [] })
  })

  it("leaves a missing report time missing instead of claiming it is now", () => {
    const report = { current: 3, updated_at: "" }

    expect(parseTask({ ...raw, progress: report }).progress).toEqual({ current: 3, sections: [] })
  })
})
