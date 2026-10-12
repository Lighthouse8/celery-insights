import { render, screen } from "@test-utils"
import userEvent from "@testing-library/user-event"
import { parseTaskNodeFields } from "@lib/task-node-fields"
import useSettingsStore, { resetSettings } from "@stores/use-settings-store"
import { ReactFlowProvider } from "@xyflow/react"
import TaskLabelsControl from "./task-labels-control"

describe("TaskLabelsControl", () => {
  beforeEach(() => {
    localStorage.clear()
    resetSettings()
  })

  it("switches single fields off and on again", async () => {
    const user = userEvent.setup()
    render(
      <ReactFlowProvider>
        <TaskLabelsControl fields={parseTaskNodeFields("type,kwargs.channel")} />
      </ReactFlowProvider>,
    )

    await user.click(screen.getByRole("button", { name: "Task labels" }))
    const channel = screen.getByText("kwargs.channel").closest("label")!.querySelector("button")!
    expect(channel).toHaveAttribute("data-state", "checked")

    await user.click(channel)
    expect(useSettingsStore.getState().hiddenTaskNodeFields).toEqual(["kwargs.channel"])
    expect(channel).toHaveAttribute("data-state", "unchecked")

    await user.click(channel)
    expect(useSettingsStore.getState().hiddenTaskNodeFields).toEqual([])
  })
})
