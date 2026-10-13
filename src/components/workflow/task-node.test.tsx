import { render, screen } from "@test-utils"
import { createTask } from "@test-fixtures"
import { TaskNodeFieldsContext } from "@hooks/use-task-node-fields"
import { parseTaskNodeFields } from "@lib/task-node-fields"
import { ReactFlowProvider } from "@xyflow/react"
import TaskNode from "./task-node"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children?: React.ReactNode; to: string; [key: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

const renderNode = (spec: string) => {
  const task = createTask({
    type: "resources.marketing.channel_run.start_resource_run",
    kwargs: "{'channel': 'facebook_ads', 'organization_id': 12}",
  })
  const props = { id: task.id, data: task } as unknown as React.ComponentProps<typeof TaskNode>
  return render(
    <ReactFlowProvider>
      <TaskNodeFieldsContext.Provider value={parseTaskNodeFields(spec)}>
        <TaskNode {...props} />
      </TaskNodeFieldsContext.Provider>
    </ReactFlowProvider>,
  )
}

describe("TaskNode", () => {
  it("draws a label line per field with the full value as its title", () => {
    renderNode("type,kwargs.channel,kwargs.organization_id:org,kwargs.missing")

    expect(screen.getByText("start_resource_run")).toHaveAttribute(
      "title",
      "resources.marketing.channel_run.start_resource_run",
    )
    expect(screen.getByText("channel=facebook_ads")).toHaveAttribute("title", "facebook_ads")
    expect(screen.getByText("org=12")).toBeInTheDocument()
    expect(screen.queryByText(/missing/)).not.toBeInTheDocument()
  })

  it("draws no labels without fields", () => {
    const { container } = renderNode("")
    expect(container.querySelectorAll("span[title]")).toHaveLength(0)
  })
})
