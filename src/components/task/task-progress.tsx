import { Progress } from "@components/ui/progress"
import { LockKeyhole } from "lucide-react"
import { TaskState, type Task, type TaskProgress as TaskProgressRecord } from "@/types/surreal-records"
import React from "react"

/** A finished task keeps its last report, so its label says so. */
export const progressLabel = (state: TaskState) => (state === TaskState.STARTED ? "Progress" : "Last progress")

/** The workflow graph's bar: only for a running task whose total is known. */
export const runningProgressPercent = (task: Task): number | undefined =>
  task.state === TaskState.STARTED && task.progress?.total
    ? Math.min(100, (task.progress.current / task.progress.total) * 100)
    : undefined

const formatCount = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })

const TaskProgress: React.FC<{ progress: TaskProgressRecord; descriptionRestricted?: boolean }> = ({
  progress,
  descriptionRestricted = false,
}) => {
  const count = progress.total
    ? `${formatCount(progress.current)}/${formatCount(progress.total)}`
    : formatCount(progress.current)
  return (
    <div className="flex min-w-0 items-center gap-2">
      {progress.total ? (
        // A task that overshoots its total keeps its real count; only the bar stops at full.
        <Progress
          value={Math.min(100, (progress.current / progress.total) * 100)}
          className="min-w-24 flex-1"
          aria-label="Task progress"
        />
      ) : null}
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{count}</span>
      {progress.description && <span className="truncate text-muted-foreground">{progress.description}</span>}
      {descriptionRestricted && !progress.description && (
        // The description is task-written text, so it follows result access. The marker shows whether or not
        // the task sent one, so it can't reveal that a hidden description exists.
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <LockKeyhole className="size-3" aria-hidden="true" />
          Description not available to you
        </span>
      )}
    </div>
  )
}

export default TaskProgress
