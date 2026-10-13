import { render } from "@test-utils"
import { createTask } from "@test-fixtures"
import { TaskState, type Task } from "@/types/surreal-records"
import { ReactFlowProvider } from "@xyflow/react"
import type { ComponentProps } from "react"
import useSettingsStore, { resetSettings } from "@stores/use-settings-store"
import TaskNode from "./task-node"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children?: React.ReactNode; to: string; [key: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

const renderNode = (task: Task) =>
  render(
    <ReactFlowProvider>
      <TaskNode {...({ id: task.id, data: task } as unknown as ComponentProps<typeof TaskNode>)} />
    </ReactFlowProvider>,
  )

const progressBar = () => document.querySelector("[data-slot=progress]")
const progress = { current: 3, total: 4, updated_at: new Date(), sections: [] }

describe("TaskNode", () => {
  beforeEach(() => useSettingsStore.setState({ showTaskProgress: true }))
  afterEach(() => resetSettings())

  it("draws no bar while task progress is turned off in the settings", () => {
    useSettingsStore.setState({ showTaskProgress: false })
    renderNode(createTask({ state: TaskState.STARTED, progress }))
    expect(progressBar()).toBeNull()
  })

  it("draws the progress bar under a running task with a total, outside the layout box", () => {
    renderNode(createTask({ state: TaskState.STARTED, progress }))

    expect(progressBar()).not.toBeNull()
    expect(progressBar()).toHaveClass("absolute")
  })

  it("draws no bar for a finished task or one without a total", () => {
    renderNode(createTask({ state: TaskState.SUCCESS, progress }))
    expect(progressBar()).toBeNull()
  })

  it("draws no bar when the total is unknown", () => {
    renderNode(createTask({ state: TaskState.STARTED, progress: { current: 3, updated_at: new Date(), sections: [] } }))
    expect(progressBar()).toBeNull()
  })
})
