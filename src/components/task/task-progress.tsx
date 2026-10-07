import LinearProgressWithLabel from "@components/common/linear-progress-with-label"
import type { TaskProgress as TaskProgressRecord } from "@/types/surreal-records"
import React from "react"

const TaskProgress: React.FC<{ progress: TaskProgressRecord }> = ({ progress }) => (
  <div className="flex min-w-0 items-center gap-2">
    {progress.total ? (
      <div className="min-w-24 flex-1">
        <LinearProgressWithLabel value={Math.min(progress.current, progress.total)} max={progress.total} />
      </div>
    ) : (
      <span className="tabular-nums">{progress.current}</span>
    )}
    {progress.description && <span className="truncate text-muted-foreground">{progress.description}</span>}
  </div>
)

export default TaskProgress
