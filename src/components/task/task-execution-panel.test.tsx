import { render, screen } from "@test-utils"
import { TaskState } from "@/types/surreal-records"
import { createTask } from "@test-fixtures"
import TaskExecutionPanel from "./task-execution-panel"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

const now = new Date("2026-10-06T12:00:00Z")

const startedTask = (overrides: Parameters<typeof createTask>[0]) =>
  createTask({
    state: TaskState.STARTED,
    sent_at: new Date(now.getTime() - 70_000),
    received_at: new Date(now.getTime() - 69_000),
    started_at: new Date(now.getTime() - 60_000),
    last_updated: new Date(now.getTime() - 60_000),
    succeeded_at: undefined,
    runtime: undefined,
    ...overrides,
  })

describe("TaskExecutionPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })
  afterEach(() => vi.useRealTimers())

  it("shows the frozen runtime when execution is unconfirmed", () => {
    render(
      <TaskExecutionPanel
        task={startedTask({
          started_at: new Date(now.getTime() - 200_000),
          last_updated: new Date(now.getTime() - 200_000),
          execution_active: true,
          execution_observed_at: new Date(now.getTime() - 150_000),
          execution_active_at: new Date(now.getTime() - 150_000),
        })}
      />,
    )
    expect(screen.getByText("Runtime unconfirmed:").nextElementSibling).toHaveTextContent("50.0s")
  })

  it("shows a live runtime for observed execution", () => {
    render(<TaskExecutionPanel task={startedTask({ execution_active: true, execution_observed_at: now })} />)
    expect(screen.getByText("Runtime:").nextElementSibling).toHaveTextContent("1min, 0.0s")
  })

  it("offers the last report time only when it is known", () => {
    const progress = { current: 3, total: 10 }
    const { unmount } = render(
      <TaskExecutionPanel task={startedTask({ progress: { ...progress, updated_at: now } })} />,
    )
    expect(screen.getByText("Progress:")).toHaveAttribute("data-slot", "tooltip-trigger")
    unmount()

    render(<TaskExecutionPanel task={startedTask({ progress })} />)
    expect(screen.getByText("Progress:")).not.toHaveAttribute("data-slot")
  })

  it("marks the progress description as restricted without result access", () => {
    const progress = { current: 3, total: 10, updated_at: now }
    const { unmount } = render(
      <TaskExecutionPanel task={startedTask({ progress, restricted_fields: ["task.result.read"] })} />,
    )
    expect(screen.getByText("Description not available to you")).toBeInTheDocument()
    unmount()

    render(<TaskExecutionPanel task={startedTask({ progress, restricted_fields: ["task.input.read"] })} />)
    expect(screen.queryByText("Description not available to you")).toBeNull()
  })
})
