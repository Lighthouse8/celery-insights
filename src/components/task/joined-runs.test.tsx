import { render, screen } from "@test-utils"
import JoinedRuns from "./joined-runs"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children?: React.ReactNode; params: { taskId: string } }) => (
    <a href={`/tasks/${params.taskId}`}>{children}</a>
  ),
}))

describe("JoinedRuns", () => {
  it("links each joined run to its task page", () => {
    render(<JoinedRuns taskIds={["run-1", "run-2"]} />)

    expect(screen.getByText("Joined runs")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "run-1" })).toHaveAttribute("href", "/tasks/run-1")
    expect(screen.getByRole("link", { name: "run-2" })).toHaveAttribute("href", "/tasks/run-2")
  })

  it("renders nothing for a task that joined no run", () => {
    const { container } = render(<JoinedRuns taskIds={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })
})
