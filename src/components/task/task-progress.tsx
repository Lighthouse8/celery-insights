import { Progress } from "@components/ui/progress"
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

const TaskProgress: React.FC<{ progress: TaskProgressRecord }> = ({ progress }) => {
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
    </div>
  )
}

export default TaskProgress
