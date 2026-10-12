import { render, screen, within } from "@test-utils"
import { createTask } from "@test-fixtures"
import { TaskState, type TaskProgress } from "@/types/surreal-records"
import TaskProgressPanel, { progressLabel, runningProgressPercent } from "./task-progress"

const updated_at = new Date("2025-06-15T12:00:00Z")
const report = (progress: Partial<TaskProgress>): TaskProgress => ({ current: 0, sections: [], ...progress })

describe("TaskProgressPanel", () => {
  it("renders nothing when the task never reported progress", () => {
    const { container } = render(<TaskProgressPanel task={createTask({ progress: undefined })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("puts the overall position first and each section on its own line under it", () => {
    const progress = report({
      current: 2,
      total: 3,
      updated_at,
      sections: [
        { description: "Levels", current: 2, total: 3 },
        { description: "Days", current: 17, total: 90 },
        { description: "Report pages", current: 4 },
      ],
    })
    render(<TaskProgressPanel task={createTask({ state: TaskState.STARTED, progress })} />)

    expect(screen.getByText("Progress")).toBeInTheDocument()
    expect(screen.getByText("Overall")).toBeInTheDocument()
    const items = within(screen.getByRole("list", { name: "Progress sections" })).getAllByRole("listitem")
    expect(items.map((item) => item.textContent)).toEqual(["Levels2/3", "Days17/90", "Report pages4"])
    // Overall, Levels and Days have totals, so they get bars; the pages count doesn't.
    expect(document.querySelectorAll("[data-slot=progress]")).toHaveLength(3)
    expect(screen.getByText(`Last reported ${updated_at.toLocaleString()}`)).toBeInTheDocument()
  })

  it("labels the overall line with the description next to its sections", () => {
    const progress = report({
      current: 1,
      total: 4,
      description: "Importing rows",
      sections: [{ description: "Batches", current: 1, total: 4 }],
    })
    render(<TaskProgressPanel task={createTask({ progress })} />)
    expect(screen.getByText("Importing rows")).toBeInTheDocument()
    expect(screen.queryByText("Overall")).toBeNull()
    expect(screen.getByText("Batches")).toBeInTheDocument()
  })

  it("labels the overall line with the description when the task sent no sections", () => {
    render(
      <TaskProgressPanel
        task={createTask({ progress: report({ current: 4, total: 10, description: "Caching days" }) })}
      />,
    )
    expect(screen.getByText("Caching days")).toBeInTheDocument()
    expect(screen.getByText("4/10")).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "Progress sections" })).toBeNull()
  })

  it("titles a finished task's report as its last progress", () => {
    render(<TaskProgressPanel task={createTask({ state: TaskState.SUCCESS, progress: report({ current: 1 }) })} />)
    expect(screen.getByText("Last progress")).toBeInTheDocument()
  })

  it("names sections by level and marks descriptions restricted without result access", () => {
    const progress = report({ current: 1, total: 2, sections: [{ current: 1, total: 2 }, { current: 5 }] })
    render(<TaskProgressPanel task={createTask({ progress, restricted_fields: ["task.result.read"] })} />)
    expect(screen.getByText("Level 1")).toBeInTheDocument()
    expect(screen.getByText("Level 2")).toBeInTheDocument()
    expect(screen.getByText("Descriptions not available to you")).toBeInTheDocument()
  })

  it("shows no marker when result access is allowed", () => {
    render(<TaskProgressPanel task={createTask({ progress: report({ current: 3, total: 10 }) })} />)
    expect(screen.queryByText("Descriptions not available to you")).toBeNull()
  })

  it("keeps the real count when a task overshoots, and rounds fractions", () => {
    const progress = report({ current: 12, total: 10, sections: [{ current: 0.3333333333, total: 1 }] })
    render(<TaskProgressPanel task={createTask({ progress })} />)
    expect(screen.getByText("12/10")).toBeInTheDocument()
    expect(screen.getByText("0.33/1")).toBeInTheDocument()
  })

  it("shows only the count when the total is unknown", () => {
    render(<TaskProgressPanel task={createTask({ progress: report({ current: 7 }) })} />)
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
  const progress = report({ current: 3, total: 4, updated_at })

  it("fills the graph bar only for a running task with a known total", () => {
    expect(runningProgressPercent(createTask({ state: TaskState.STARTED, progress }))).toBe(75)
    expect(runningProgressPercent(createTask({ state: TaskState.SUCCESS, progress }))).toBeUndefined()
    expect(
      runningProgressPercent(createTask({ state: TaskState.STARTED, progress: report({ current: 3 }) })),
    ).toBeUndefined()
    expect(runningProgressPercent(createTask({ state: TaskState.STARTED }))).toBeUndefined()
  })

  it("stops the bar at full when a task overshoots", () => {
    expect(
      runningProgressPercent(createTask({ state: TaskState.STARTED, progress: report({ current: 12, total: 10 }) })),
    ).toBe(100)
  })
})
