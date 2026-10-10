import { render, screen } from "@test-utils"
import { createTask } from "@test-fixtures"
import { TaskState } from "@/types/surreal-records"
import TaskProgress, { progressLabel, runningProgressPercent } from "./task-progress"

const updated_at = new Date("2025-06-15T12:00:00Z")

describe("TaskProgress", () => {
  it("shows a bar with the count and description when the total is known", () => {
    render(<TaskProgress progress={{ current: 4, total: 10, description: "Caching days", updated_at }} />)
    expect(screen.getByText("4/10")).toBeInTheDocument()
    expect(screen.getByText("Caching days")).toBeInTheDocument()
    expect(document.querySelector("[data-slot=progress]")).not.toBeNull()
  })

  it("keeps the real count when a task overshoots its total", () => {
    render(<TaskProgress progress={{ current: 12, total: 10, updated_at }} />)
    expect(screen.getByText("12/10")).toBeInTheDocument()
  })

  it("rounds fractional counts", () => {
    render(<TaskProgress progress={{ current: 0.3333333333, total: 1, updated_at }} />)
    expect(screen.getByText("0.33/1")).toBeInTheDocument()
  })

  it("shows only the count when the total is unknown", () => {
    render(<TaskProgress progress={{ current: 7, updated_at }} />)
    expect(screen.getByText("7")).toBeInTheDocument()
    expect(document.querySelector("[data-slot=progress]")).toBeNull()
  })
})

describe("progressLabel", () => {
  it("calls a running task's report progress and a finished task's the last progress", () => {
    expect(progressLabel(TaskState.STARTED)).toBe("Progress")
    expect(progressLabel(TaskState.SUCCESS)).toBe("Last progress")
    expect(progressLabel(TaskState.FAILURE)).toBe("Last progress")
  })
})

describe("runningProgressPercent", () => {
  const progress = { current: 3, total: 4, updated_at }

  it("fills the graph bar only for a running task with a known total", () => {
    expect(runningProgressPercent(createTask({ state: TaskState.STARTED, progress }))).toBe(75)
    expect(runningProgressPercent(createTask({ state: TaskState.SUCCESS, progress }))).toBeUndefined()
    expect(
      runningProgressPercent(createTask({ state: TaskState.STARTED, progress: { current: 3, updated_at } })),
    ).toBeUndefined()
    expect(runningProgressPercent(createTask({ state: TaskState.STARTED }))).toBeUndefined()
  })

  it("stops the bar at full when a task overshoots", () => {
    expect(
      runningProgressPercent(
        createTask({ state: TaskState.STARTED, progress: { current: 12, total: 10, updated_at } }),
      ),
    ).toBe(100)
  })
})
