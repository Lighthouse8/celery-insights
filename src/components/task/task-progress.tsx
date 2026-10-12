import Panel from "@components/common/panel"
import { Progress } from "@components/ui/progress"
import { cn } from "@lib/utils"
import { LockKeyhole } from "lucide-react"
import { TaskState, type Task } from "@/types/surreal-records"
import React from "react"

/** A finished task keeps its last report, so its title says so. */
export const progressLabel = (state: TaskState) => (state === TaskState.STARTED ? "Progress" : "Last progress")

/** The workflow graph's bar: only for a running task whose total is known. */
export const runningProgressPercent = (task: Task): number | undefined =>
  task.state === TaskState.STARTED && task.progress?.total
    ? Math.min(100, (task.progress.current / task.progress.total) * 100)
    : undefined

const formatCount = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })

interface ProgressLineProps {
  label: React.ReactNode
  current: number
  total?: number
  emphasis?: boolean
}

/** A label and its count on one line, with the bar underneath when the total is known. */
export const ProgressLine: React.FC<ProgressLineProps> = ({ label, current, total, emphasis = false }) => (
  <div className="min-w-0 space-y-1">
    <div className={cn("flex items-baseline justify-between gap-3", emphasis ? "text-sm font-medium" : "text-sm")}>
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {total ? `${formatCount(current)}/${formatCount(total)}` : formatCount(current)}
      </span>
    </div>
    {total ? (
      // A task that overshoots its total keeps its real count; only the bar stops at full.
      <Progress
        value={Math.min(100, (current / total) * 100)}
        className={emphasis ? "h-2" : "h-1.5"}
        aria-label={typeof label === "string" ? label : undefined}
      />
    ) : null}
  </div>
)

const RestrictedMarker = () => (
  // Descriptions are task-written text, so they follow result access. The marker shows whether or not the task
  // sent any, so it can't reveal that hidden text exists.
  <span className="flex items-center gap-1 text-xs text-muted-foreground">
    <LockKeyhole className="size-3" aria-hidden="true" />
    Descriptions not available to you
  </span>
)

/** The task's reported progress: the overall position first, then each nested loop on its own line. */
const TaskProgressPanel: React.FC<{ task: Task }> = ({ task }) => {
  const progress = task.progress
  if (!progress) return null
  const restricted = task.restricted_fields?.includes("task.result.read") ?? false
  const { sections } = progress
  return (
    <Panel title={progressLabel(task.state)}>
      <div className="space-y-4 p-3">
        <ProgressLine
          emphasis
          label={sections.length ? "Overall" : (progress.description ?? "Overall")}
          current={progress.current}
          total={progress.total}
        />
        {sections.length ? (
          <ol className="space-y-3 border-l pl-3" aria-label="Progress sections">
            {sections.map((section, index) => (
              <li key={index} style={{ marginLeft: `${index * 0.75}rem` }}>
                <ProgressLine
                  label={section.description ?? `Level ${index + 1}`}
                  current={section.current}
                  total={section.total}
                />
              </li>
            ))}
          </ol>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{progress.updated_at ? `Last reported ${progress.updated_at.toLocaleString()}` : null}</span>
          {restricted && <RestrictedMarker />}
        </div>
      </div>
    </Panel>
  )
}

export default TaskProgressPanel
