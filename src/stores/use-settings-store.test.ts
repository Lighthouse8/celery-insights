import { renderHook } from "@testing-library/react"
import useSettingsStore, { PreferredTheme, resetSettings, useIsDefaultSettings } from "./use-settings-store"

beforeEach(() => {
  localStorage.clear()
  resetSettings()
})

describe("useSettingsStore", () => {
  it("has correct default values", () => {
    const state = useSettingsStore.getState()

    expect(state.theme).toBe(PreferredTheme.SYSTEM)
    expect(state.hideWelcomeBanner).toBe(false)
    expect(state.rawEventsLimit).toBe(100)
    // Experimental, so off until a user turns it on.
    expect(state.showTaskProgress).toBe(false)
  })

  it("resetSettings restores defaults after modification", () => {
    useSettingsStore.setState({ theme: PreferredTheme.DARK, hideWelcomeBanner: true })

    resetSettings()

    const state = useSettingsStore.getState()
    expect(state.theme).toBe(PreferredTheme.SYSTEM)
    expect(state.hideWelcomeBanner).toBe(false)
  })

  it("replaces the state on setState(state, true), recording only that state's settings as chosen", () => {
    useSettingsStore.setState({ hideWelcomeBanner: true })

    useSettingsStore.setState({ theme: PreferredTheme.DARK } as ReturnType<typeof useSettingsStore.getState>, true)

    expect(useSettingsStore.getState()).toEqual({ theme: PreferredTheme.DARK, userSet: ["theme"] })
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  })
})

describe("useIsDefaultSettings", () => {
  it("returns true when settings match defaults", () => {
    const { result } = renderHook(() => useIsDefaultSettings())
    expect(result.current).toBe(true)
  })

  it("returns false when settings differ from defaults", () => {
    useSettingsStore.setState({ theme: PreferredTheme.DARK })

    const { result } = renderHook(() => useIsDefaultSettings())
    expect(result.current).toBe(false)
  })
})
