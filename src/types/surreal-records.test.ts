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

  it("parses reported progress and drops empty optional fields", () => {
    const task = parseTask({
      ...raw,
      progress: { current: 3, total: null, description: "", updated_at: "2025-06-15T12:00:05Z" },
    })
    expect(task.progress).toEqual({ current: 3, updated_at: new Date("2025-06-15T12:00:05Z") })
  })
})
