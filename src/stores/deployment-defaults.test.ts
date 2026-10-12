import { describe, expect, it } from "vitest"
import useSettingsStore, {
  applyDeploymentDefaults,
  PreferredTheme,
  resetSettings,
  useDeploymentSettings,
} from "./use-settings-store"

describe("deployment defaults", () => {
  it("applies operator defaults to a browser without saved preferences", () => {
    localStorage.clear()
    applyDeploymentDefaults({ theme: "dark", hideWelcomeBanner: true, rawEventsLimit: 250 })
    expect(useSettingsStore.getState()).toMatchObject({
      theme: PreferredTheme.DARK,
      hideWelcomeBanner: true,
      rawEventsLimit: 250,
    })
  })

  it("preserves saved preferences and uses deployment defaults on explicit reset", () => {
    useSettingsStore.setState({ theme: PreferredTheme.LIGHT, rawEventsLimit: 100 })
    applyDeploymentDefaults({ theme: "dark", rawEventsLimit: 500 })
    expect(useSettingsStore.getState().theme).toBe(PreferredTheme.LIGHT)
    resetSettings()
    expect(useSettingsStore.getState().theme).toBe(PreferredTheme.DARK)
    expect(useSettingsStore.getState().rawEventsLimit).toBe(500)
  })

  it("applies a deployment default to a setting the browser saved before it existed", () => {
    useSettingsStore.setState({ theme: PreferredTheme.LIGHT, taskNodeLabels: false })
    // Saved by a version without the task node settings.
    localStorage.setItem("settings", JSON.stringify({ state: { theme: PreferredTheme.LIGHT }, version: 0 }))
    applyDeploymentDefaults({ theme: "dark", taskNodeLabels: true, taskNodeFields: "type,kwargs.channel" })
    expect(useSettingsStore.getState()).toMatchObject({
      theme: PreferredTheme.LIGHT,
      taskNodeLabels: true,
      taskNodeFields: "type,kwargs.channel",
    })
  })

  it("disables a saved demo preference and does not reenable it on reset", () => {
    useSettingsStore.setState({ demo: true })
    applyDeploymentDefaults({ demoAvailable: false })
    expect(useDeploymentSettings.getState().demoAvailable).toBe(false)
    expect(useSettingsStore.getState().demo).toBe(false)
    resetSettings()
    expect(useSettingsStore.getState().demo).toBe(false)
  })
})
