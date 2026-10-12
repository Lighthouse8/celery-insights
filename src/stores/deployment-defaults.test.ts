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

  it("keeps settings a version 0 browser saved and applies defaults to the rest", async () => {
    localStorage.setItem("settings", JSON.stringify({ state: { theme: PreferredTheme.LIGHT }, version: 0 }))
    await useSettingsStore.persist.rehydrate()
    expect(useSettingsStore.getState().userSet).toEqual(["theme"])
    applyDeploymentDefaults({ theme: "dark", taskNodeLabels: true, taskNodeFields: "type,kwargs.channel" })
    expect(useSettingsStore.getState()).toMatchObject({
      theme: PreferredTheme.LIGHT,
      taskNodeLabels: true,
      taskNodeFields: "type,kwargs.channel",
    })
  })

  it("applies a deployment default that changed after the browser last saved its settings", () => {
    localStorage.clear()
    resetSettings()
    applyDeploymentDefaults({ taskNodeLabels: false })
    useSettingsStore.setState({ hideWelcomeBanner: true })
    expect(JSON.parse(localStorage.getItem("settings")!).state).toEqual({
      hideWelcomeBanner: true,
      userSet: ["hideWelcomeBanner"],
    })
    applyDeploymentDefaults({ taskNodeLabels: true, taskNodeFields: "type,kwargs.level" })
    expect(useSettingsStore.getState()).toMatchObject({
      hideWelcomeBanner: true,
      taskNodeLabels: true,
      taskNodeFields: "type,kwargs.level",
    })
  })

  it("keeps a chosen value that equals the default when the default changes, across reloads", async () => {
    localStorage.clear()
    resetSettings()
    applyDeploymentDefaults({ taskNodeLabels: false, rawEventsLimit: 100 })
    // Chosen before the deployment defaults below arrive, and equal to the defaults at the time.
    useSettingsStore.setState({ taskNodeLabels: false, rawEventsLimit: 100 })
    applyDeploymentDefaults({ taskNodeLabels: true, rawEventsLimit: 500 })
    await useSettingsStore.persist.rehydrate()
    applyDeploymentDefaults({ taskNodeLabels: true, rawEventsLimit: 500 })
    expect(useSettingsStore.getState()).toMatchObject({ taskNodeLabels: false, rawEventsLimit: 100 })
    resetSettings()
    expect(useSettingsStore.getState()).toMatchObject({ taskNodeLabels: true, rawEventsLimit: 500, userSet: [] })
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
