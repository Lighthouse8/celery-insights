import { parseTaskNodeFields, type TaskNodeField } from "@lib/task-node-fields"
import useSettingsStore from "@stores/use-settings-store"
import { createContext, useMemo } from "react"

/** The fields every task node labels, parsed once by the graph rather than per node. */
export const TaskNodeFieldsContext = createContext<TaskNodeField[]>([])

/** The configured task node fields, and the ones the workflow graph shows (none while labels are off). */
export const useTaskNodeFields = (): { fields: TaskNodeField[]; visible: TaskNodeField[] } => {
  const enabled = useSettingsStore((state) => state.taskNodeLabels)
  const spec = useSettingsStore((state) => state.taskNodeFields)
  const hidden = useSettingsStore((state) => state.hiddenTaskNodeFields)
  return useMemo(() => {
    const fields = parseTaskNodeFields(spec)
    return { fields, visible: enabled ? fields.filter((field) => !hidden.includes(field.path)) : [] }
  }, [enabled, spec, hidden])
}
