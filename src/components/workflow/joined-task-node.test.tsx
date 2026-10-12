import { render, screen } from "@test-utils"
import { createTask } from "@test-fixtures"
import { ReactFlowProvider } from "@xyflow/react"
import type { ComponentProps } from "react"
import { JoinedTaskNode } from "./task-node"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

const renderNode = (data: { taskId: string; task?: ReturnType<typeof createTask> }) =>
  render(
    <ReactFlowProvider>
      <JoinedTaskNode
        {...({ id: `joined:${data.taskId}`, data } as unknown as ComponentProps<typeof JoinedTaskNode>)}
      />
    </ReactFlowProvider>,
  )

describe("JoinedTaskNode", () => {
  it("draws a loaded run with a dashed border, a label and a link to its page", () => {
    renderNode({ taskId: "4f1c2a9e-run", task: createTask({ id: "4f1c2a9e-run" }) })

    expect(screen.getByText("joined run")).toBeInTheDocument()
    expect(screen.getByRole("link")).toHaveAttribute("href", "/tasks/4f1c2a9e-run")
    expect(document.querySelector(".border-dashed")).not.toBeNull()
  })

  it("draws an unloaded run as a placeholder with its short id", () => {
    renderNode({ taskId: "4f1c2a9e-0000-unknown" })

    expect(screen.getByText("joined run 4f1c2a9e")).toBeInTheDocument()
    expect(screen.getByRole("link")).toHaveAttribute("href", "/tasks/4f1c2a9e-0000-unknown")
  })
})
