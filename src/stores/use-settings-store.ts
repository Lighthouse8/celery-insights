import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

export enum PreferredTheme {
  LIGHT = "light",
  DARK = "dark",
  SYSTEM = "system",
}

interface Settings {
  theme: PreferredTheme
  hideWelcomeBanner: boolean
  demo: boolean
  rawEventsLimit: number
  taskNodeLabels: boolean
  taskNodeFields: string
  /** Fields (by path) switched off from the workflow graph; they stay in the configured list. */
  hiddenTaskNodeFields: string[]
}

const defaultSettings: Settings = {
  theme: PreferredTheme.SYSTEM,
  hideWelcomeBanner: false,
  demo: import.meta.env.DEV || Boolean(import.meta.env.VITE_DEMO_MODE),
  rawEventsLimit: 100,
  taskNodeLabels: false,
  taskNodeFields: "type",
  hiddenTaskNodeFields: [],
}

export const useDeploymentSettings = create<{ demoAvailable: boolean }>(() => ({ demoAvailable: true }))

export function applyDeploymentDefaults(config: {
  demoAvailable?: boolean
  theme?: "light" | "dark" | "system"
  hideWelcomeBanner?: boolean
  rawEventsLimit?: number
  taskNodeLabels?: boolean
  taskNodeFields?: string
}): void {
  let saved: Record<string, unknown> | undefined
  try {
    saved = JSON.parse(localStorage.getItem("settings") ?? "null")?.state
  } catch {
    saved = undefined
  }
  if (config.theme)
    defaultSettings.theme = { light: PreferredTheme.LIGHT, dark: PreferredTheme.DARK, system: PreferredTheme.SYSTEM }[
      config.theme
    ]
  if (config.hideWelcomeBanner !== undefined) defaultSettings.hideWelcomeBanner = config.hideWelcomeBanner
  if (config.rawEventsLimit !== undefined) defaultSettings.rawEventsLimit = config.rawEventsLimit
  if (config.taskNodeLabels !== undefined) defaultSettings.taskNodeLabels = config.taskNodeLabels
  if (config.taskNodeFields !== undefined) defaultSettings.taskNodeFields = config.taskNodeFields
  const demoAvailable = config.demoAvailable ?? true
  if (!demoAvailable) defaultSettings.demo = false
  useDeploymentSettings.setState({ demoAvailable })
  // Saved preferences win; every other setting follows the deployment default (see partialize below).
  useSettingsStore.setState(
    Object.fromEntries(Object.entries(defaultSettings).filter(([key]) => !saved || !(key in saved))),
  )
  if (!demoAvailable) useSettingsStore.setState({ demo: false })
}
const useSettingsStore = create<Settings>()(
  persist(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (set) => defaultSettings,
    {
      name: "settings",
      storage: createJSONStorage(() => localStorage),
      // Only settings that differ from the defaults are saved, so the rest keep following deployment defaults
      // that change later instead of freezing at whatever they were on the browser's first visit.
      partialize: (state) =>
        Object.fromEntries(
          Object.entries(state).filter(
            ([key, value]) => JSON.stringify(value) !== JSON.stringify(defaultSettings[key as keyof Settings]),
          ),
        ) as Partial<Settings>,
    },
  ),
)

export const resetSettings = () => useSettingsStore.setState(defaultSettings)
export const useIsDefaultSettings = () =>
  useSettingsStore((state) => JSON.stringify(state) === JSON.stringify(defaultSettings))

export default useSettingsStore
