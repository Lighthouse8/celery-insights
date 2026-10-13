import { render, screen } from "@test-utils"
import { createTask } from "@test-fixtures"
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
