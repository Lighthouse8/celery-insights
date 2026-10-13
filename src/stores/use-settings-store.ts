import { create, type StateCreator } from "zustand"
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
  /** The settings this browser's user chose. Only these are saved; the rest follow the defaults. */
  userSet: SettingKey[]
}

type SettingKey = Exclude<keyof Settings, "userSet">

const defaultSettings: Settings = {
  theme: PreferredTheme.SYSTEM,
  hideWelcomeBanner: false,
  demo: import.meta.env.DEV || Boolean(import.meta.env.VITE_DEMO_MODE),
  rawEventsLimit: 100,
  taskNodeLabels: false,
  taskNodeFields: "type",
  hiddenTaskNodeFields: [],
  userSet: [],
}

// Writes defaults without recording them as the user's choice; set up with the store below.
let setDefaults: (state: Partial<Settings>) => void = () => undefined

/**
 * Every write through the store's setState is a user's choice: its keys are saved and win over deployment
 * defaults from then on, even when the chosen value equals the current default.
 */
const recordUserChoices =
  (config: StateCreator<Settings>): StateCreator<Settings> =>
  (set, get, api) => {
    setDefaults = (state) => set(state)
    const setState = api.setState
    api.setState = ((partial: Partial<Settings> | ((state: Settings) => Partial<Settings>), replace?: boolean) => {
      const next = typeof partial === "function" ? partial(get()) : partial
      const chosen = Object.keys(next).filter((key): key is SettingKey => key !== "userSet")
      // A replace keeps only the given settings, so only those stay chosen.
      const userSet = replace ? chosen : [...new Set([...get().userSet, ...chosen])]
      setState({ ...next, userSet } as Settings, replace as true)
    }) as typeof api.setState
    return config(set, get, api)
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
  const { userSet } = useSettingsStore.getState()
  setDefaults(
    Object.fromEntries(
      Object.entries(defaultSettings).filter(([key]) => key !== "userSet" && !userSet.includes(key as SettingKey)),
    ),
  )
  if (!demoAvailable) setDefaults({ demo: false })
}
const useSettingsStore = create<Settings>()(
  persist(
    recordUserChoices(() => defaultSettings),
    {
      name: "settings",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        ...Object.fromEntries(state.userSet.map((key) => [key, state[key]])),
        userSet: state.userSet,
      }),
      version: 1,
      // Version 0 saved the whole state, and every saved setting won over deployment defaults.
      migrate: (persisted, version) => {
        const state = persisted as Partial<Settings>
        return (version < 1 ? { ...state, userSet: Object.keys(state) } : state) as Settings
      },
    },
  ),
)

export const resetSettings = () => setDefaults(defaultSettings)
export const useIsDefaultSettings = () =>
  useSettingsStore((state) => JSON.stringify(state) === JSON.stringify(defaultSettings))

export default useSettingsStore
