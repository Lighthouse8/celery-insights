import { render, screen } from "@test-utils"
import userEvent from "@testing-library/user-event"
import useSettingsStore, { PreferredTheme, resetSettings } from "@stores/use-settings-store"
import SettingsPanel, { SettingsPanelAction } from "./settings-panel"

describe("SettingsPanel", () => {
  beforeEach(() => {
    localStorage.clear()
    resetSettings()
  })

  it("renders the workspace controls", () => {
    render(<SettingsPanel />)

    expect(screen.getByText("Workspace")).toBeInTheDocument()
    expect(screen.getByText("Theme")).toBeInTheDocument()
    expect(screen.getByText("Welcome banner")).toBeInTheDocument()
    expect(screen.getByText("Demo mode")).toBeInTheDocument()
    expect(screen.getByText("Live events limit")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /start tour/i })).toBeInTheDocument()
  })

  it("switches task node labels on and names ignored fields", async () => {
    const user = userEvent.setup()
    render(<SettingsPanel />)

    const fields = screen.getByRole("textbox", { name: "Task node fields" })
    expect(fields).toBeDisabled()
    await user.click(screen.getByRole("switch", { name: /show task node labels/i }))
    expect(useSettingsStore.getState().taskNodeLabels).toBe(true)

    await user.clear(fields)
    await user.type(fields, "type,wroker")
    expect(useSettingsStore.getState().taskNodeFields).toBe("type,wroker")
    expect(screen.getByText("Ignoring wroker")).toBeInTheDocument()
    expect(fields).toHaveAttribute("aria-invalid", "true")
  })

  it("drops hidden task node fields the field list no longer names", async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({
      taskNodeLabels: true,
      taskNodeFields: "type,kwargs.channel",
      hiddenTaskNodeFields: ["kwargs.channel"],
    })
    render(<SettingsPanel />)

    const fields = screen.getByRole("textbox", { name: "Task node fields" })
    await user.clear(fields)
    await user.type(fields, "type,kwargs.channel")

    expect(useSettingsStore.getState().hiddenTaskNodeFields).toEqual([])
  })

  it("updates the welcome banner preference", async () => {
    const user = userEvent.setup()
    render(<SettingsPanel />)

    await user.click(screen.getByRole("switch", { name: /show welcome banner/i }))

    expect(useSettingsStore.getState().hideWelcomeBanner).toBe(true)
  })

  it("lists experimental settings after the others", () => {
    render(<SettingsPanel />)
    const tour = screen.getByRole("button", { name: /start tour/i })

    for (const badge of screen.getAllByText("Experimental")) {
      expect(tour.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it("resets browser defaults", async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({
      theme: PreferredTheme.DARK,
      hideWelcomeBanner: true,
      rawEventsLimit: 300,
    })

    render(
      <>
        <SettingsPanelAction />
        <SettingsPanel />
      </>,
    )
    await user.click(screen.getByRole("button", { name: /reset local settings/i }))

    const state = useSettingsStore.getState()
    expect(state.theme).toBe(PreferredTheme.SYSTEM)
    expect(state.hideWelcomeBanner).toBe(false)
    expect(state.rawEventsLimit).toBe(100)
  })
})
