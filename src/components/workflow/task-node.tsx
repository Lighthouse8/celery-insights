import TaskAvatar from "@components/task/task-avatar"
import { runningProgressPercent } from "@components/task/task-progress"
import { Progress } from "@components/ui/progress"
import type { Task } from "@/types/surreal-records"
import React from "react"
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"

type TaskNodeType = Node<Task & Record<string, unknown>, "taskNode">

const TaskNode: React.FC<NodeProps<TaskNodeType>> = ({ data }) => {
  const progressPercent = runningProgressPercent(data)
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className="relative animate-in zoom-in-75 fade-in duration-300">
        <TaskAvatar taskId={data.id} type={data.type} status={data.state} className="size-[60px]" />
        {progressPercent !== undefined ? (
          // Absolutely positioned so the bar never changes the node size the layout was computed for.
          <Progress value={progressPercent} className="absolute -bottom-2 left-0 h-1" aria-label="Task progress" />
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  )
}

export default TaskNode
