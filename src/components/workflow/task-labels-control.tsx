import { Checkbox } from "@components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@components/ui/tooltip"
import type { TaskNodeField } from "@lib/task-node-fields"
import useSettingsStore from "@stores/use-settings-store"
import { Tags } from "lucide-react"
import React from "react"
import { ControlButton } from "@xyflow/react"

/** The graph control that switches single task node label fields on and off. */
const TaskLabelsControl: React.FC<{ fields: TaskNodeField[] }> = ({ fields }) => {
  const hiddenFields = useSettingsStore((state) => state.hiddenTaskNodeFields)
  return (
    <Popover>
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <ControlButton aria-label="Task labels">
              <Tags className="size-3" />
            </ControlButton>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="right">Task labels</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="end" className="w-56 space-y-2 p-3">
        {fields.length ? (
          fields.map((field) => (
            <label key={field.path} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={!hiddenFields.includes(field.path)}
                onCheckedChange={(checked) =>
                  useSettingsStore.setState({
                    hiddenTaskNodeFields: checked
                      ? hiddenFields.filter((path) => path !== field.path)
                      : [...hiddenFields, field.path],
                  })
                }
              />
              <span className="truncate font-mono text-xs">{field.path}</span>
            </label>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">No task node fields configured.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default TaskLabelsControl
