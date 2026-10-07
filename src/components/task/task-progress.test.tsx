import { render, screen } from "@test-utils"
import TaskProgress from "./task-progress"

const updated_at = new Date("2025-06-15T12:00:00Z")

describe("TaskProgress", () => {
  it("shows a bar with the count and description when the total is known", () => {
    render(<TaskProgress progress={{ current: 4, total: 10, description: "Caching days", updated_at }} />)
    expect(screen.getByText("4/10")).toBeInTheDocument()
    expect(screen.getByText("Caching days")).toBeInTheDocument()
    expect(document.querySelector("[data-slot=progress]")).not.toBeNull()
  })

  it("caps the bar at the total when a task overshoots", () => {
    render(<TaskProgress progress={{ current: 12, total: 10, updated_at }} />)
    expect(screen.getByText("10/10")).toBeInTheDocument()
  })

  it("shows only the count when the total is unknown", () => {
    render(<TaskProgress progress={{ current: 7, updated_at }} />)
    expect(screen.getByText("7")).toBeInTheDocument()
    expect(document.querySelector("[data-slot=progress]")).toBeNull()
  })
})
