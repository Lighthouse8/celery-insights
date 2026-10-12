import TaskAvatar from "@components/task/task-avatar"
import { useTaskNodeFields } from "@hooks/use-task-node-fields"
import { taskNodeLabels } from "@lib/task-node-fields"
import type { Task } from "@/types/surreal-records"
import React, { useMemo } from "react"
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"

type TaskNodeType = Node<Task & Record<string, unknown>, "taskNode">

const TaskNode: React.FC<NodeProps<TaskNodeType>> = ({ data }) => {
  const { visible } = useTaskNodeFields()
  const labels = useMemo(() => taskNodeLabels(data, visible), [data, visible])
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className="relative animate-in zoom-in-75 fade-in duration-300">
        <TaskAvatar taskId={data.id} type={data.type} status={data.state} execution={data} className="size-[60px]" />
        {labels.length ? (
          // Absolutely positioned so the labels never change the node size the layout was computed for.
          <div className="absolute top-full left-1/2 mt-1 flex -translate-x-1/2 flex-col items-center text-[10px] leading-[14px] text-muted-foreground">
            {labels.map((label) => (
              <span
                key={label.path}
                title={label.title}
                className="max-w-[220px] truncate rounded-sm bg-background/80 px-1"
              >
                {label.text}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  )
}

export default TaskNode
