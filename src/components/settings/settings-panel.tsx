import Panel from "@components/common/panel"
import { LimitSelect } from "@components/raw_events/limit-select"
import ThemeSelector from "@components/settings/theme-selector"
import { Badge } from "@components/ui/badge"
import { Button } from "@components/ui/button"
import { Input } from "@components/ui/input"
import { Switch } from "@components/ui/switch"
import useSettingsStore, {
  resetSettings,
  useIsDefaultSettings,
  useDeploymentSettings,
} from "@stores/use-settings-store"
import { startTour } from "@stores/use-tour-store"
import { invalidTaskNodeFields } from "@lib/task-node-fields"

const SettingRow = ({
  title,
  description,
  control,
  helper,
}: {
  title: React.ReactNode
  description: string
  control: React.ReactNode
  helper?: string
}) => (
  <div className="flex flex-col gap-3 rounded-2xl border bg-background/60 p-4 md:flex-row md:items-center md:justify-between">
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      {helper && <p className="mt-2 text-xs text-muted-foreground">{helper}</p>}
    </div>
    <div className="flex shrink-0 items-center">{control}</div>
  </div>
)

const SettingsPanel = ({ hideHeader = false }: { hideHeader?: boolean }) => {
  const hideWelcomeBanner = useSettingsStore((state) => state.hideWelcomeBanner)
  const isDemo = useSettingsStore((state) => state.demo)
  const rawEventsLimit = useSettingsStore((state) => state.rawEventsLimit)
  const demoAvailable = useDeploymentSettings((state) => state.demoAvailable)
  const taskNodeLabels = useSettingsStore((state) => state.taskNodeLabels)
  const taskNodeFields = useSettingsStore((state) => state.taskNodeFields)
  const invalidFields = invalidTaskNodeFields(taskNodeFields)

  return (
    <Panel title="Workspace" hideHeader={hideHeader}>
      <div className="space-y-4 p-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          These settings stay in this browser. They do not change the running server.
        </p>
        <SettingRow title="Theme" description="Choose light, dark, or match your system." control={<ThemeSelector />} />
        <SettingRow
          title="Welcome banner"
          description="Show the getting-started banner on the home page."
          helper={hideWelcomeBanner ? "Currently hidden" : "Currently visible"}
          control={
            <Switch
              aria-label="Show welcome banner"
              checked={!hideWelcomeBanner}
              onCheckedChange={(checked) => useSettingsStore.setState({ hideWelcomeBanner: !checked })}
            />
          }
        />
        <SettingRow
          title="Demo mode"
          description="Use the embedded sample database instead of the connected backend."
          helper={isDemo ? "Currently using embedded sample data." : "Currently using the connected backend."}
          control={
            <Switch
              aria-label="Demo mode"
              checked={isDemo}
              disabled={!demoAvailable || Boolean(import.meta.env.VITE_DEMO_MODE)}
              onCheckedChange={(checked) => useSettingsStore.setState({ demo: checked })}
            />
          }
        />
        <SettingRow
          title="Live events limit"
          description="Choose how many events the Live Events page shows at once."
          helper={`Currently set to ${rawEventsLimit.toLocaleString()} events`}
          control={
            <LimitSelect
              limit={rawEventsLimit}
              setLimit={(limit) => useSettingsStore.setState({ rawEventsLimit: limit })}
            />
          }
        />
        <SettingRow
          title={
            <span className="flex items-center gap-2">
              Task node labels <Badge variant="outline">Experimental</Badge>
            </span>
          }
          description="Show task fields under each task in the workflow graph."
          helper={taskNodeLabels ? "Currently shown" : "Currently hidden"}
          control={
            <Switch
              aria-label="Show task node labels"
              checked={taskNodeLabels}
              onCheckedChange={(checked) => useSettingsStore.setState({ taskNodeLabels: checked })}
            />
          }
        />
        <SettingRow
          title={
            <span className="flex items-center gap-2">
              Task node fields <Badge variant="outline">Experimental</Badge>
            </span>
          }
          description="Comma-separated fields for task node labels: a task attribute (type, worker, routing_key), kwargs.<name>, or args.<index>. Add :alias to rename a field in its label."
          helper={
            invalidFields.length
              ? `Ignoring ${invalidFields.join(", ")}`
              : "Switch fields on and off from the workflow graph's label control."
          }
          control={
            <Input
              aria-label="Task node fields"
              className="w-80 font-mono text-xs"
              value={taskNodeFields}
              disabled={!taskNodeLabels}
              aria-invalid={invalidFields.length > 0}
              onChange={(event) => useSettingsStore.setState({ taskNodeFields: event.target.value })}
            />
          }
        />
        <SettingRow
          title="Product tour"
          description="Start the guided walkthrough again."
          control={
            <Button variant="outline" size="sm" onClick={() => startTour()}>
              Start tour
            </Button>
          }
        />
      </div>
    </Panel>
  )
}

export const SettingsPanelAction = () => {
  const isDefaultSettings = useIsDefaultSettings()

  return (
    <Button variant="outline" onClick={() => resetSettings()} disabled={isDefaultSettings}>
      Reset local settings
    </Button>
  )
}

export default SettingsPanel
