import { render, screen } from "@test-utils"
import { createTask } from "@test-fixtures"
import { TaskState } from "@/types/surreal-records"
import { ReactFlowProvider } from "@xyflow/react"
import type { ComponentProps } from "react"
import { JoinedRunNode, JoinedTaskNode } from "./task-node"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children?: React.ReactNode; to: string; params?: { taskId: string } }) => (
    <a href={params ? to.replace("$taskId", params.taskId) : to}>{children}</a>
  ),
}))

describe("JoinedRunNode", () => {
  it("draws a loaded run as a task node with a dashed border and a labelled link to its page", () => {
    const task = createTask({ id: "4f1c2a9e-run" })
    render(
      <ReactFlowProvider>
        <JoinedRunNode
          {...({ id: "joined:4f1c2a9e-run", data: task } as unknown as ComponentProps<typeof JoinedRunNode>)}
        />
      </ReactFlowProvider>,
    )

    expect(screen.getByRole("link", { name: "joined run" })).toHaveAttribute("href", "/tasks/4f1c2a9e-run")
    expect(document.querySelector(".border-dashed")).not.toBeNull()
  })

  it("shows the progress bar of a running root like any task node", () => {
    const task = createTask({
      id: "4f1c2a9e-run",
      state: TaskState.STARTED,
      progress: { current: 3, total: 4, updated_at: new Date() },
    })
    render(
      <ReactFlowProvider>
        <JoinedRunNode
          {...({ id: "joined:4f1c2a9e-run", data: task } as unknown as ComponentProps<typeof JoinedRunNode>)}
        />
      </ReactFlowProvider>,
    )

    expect(screen.getByRole("progressbar", { name: "Task progress" })).toBeInTheDocument()
  })
})

describe("JoinedTaskNode", () => {
  it("draws an unloaded run as a placeholder with its short id", () => {
    render(
      <ReactFlowProvider>
        <JoinedTaskNode
          {...({ id: "joined:x", data: { taskId: "4f1c2a9e-0000-unknown" } } as unknown as ComponentProps<
            typeof JoinedTaskNode
          >)}
        />
      </ReactFlowProvider>,
    )

    expect(screen.getByText("joined run 4f1c2a9e")).toBeInTheDocument()
    expect(screen.getByRole("link")).toHaveAttribute("href", "/tasks/4f1c2a9e-0000-unknown")
  })
})
