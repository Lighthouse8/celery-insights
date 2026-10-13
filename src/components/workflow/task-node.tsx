import TaskAvatar from "@components/task/task-avatar"
import { TaskNodeFieldsContext } from "@hooks/use-task-node-fields"
import {
  TASK_NODE_LABEL_GAP,
  TASK_NODE_LABEL_LINE_HEIGHT,
  TASK_NODE_LABEL_WIDTH,
  taskNodeLabels,
} from "@lib/task-node-fields"
import type { Task } from "@/types/surreal-records"
import React, { useContext, useMemo } from "react"
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"

type TaskNodeType = Node<Task & Record<string, unknown>, "taskNode">

const TaskNode: React.FC<NodeProps<TaskNodeType>> = ({ data }) => {
  const fields = useContext(TaskNodeFieldsContext)
  const labels = useMemo(() => taskNodeLabels(data, fields), [data, fields])
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className="relative animate-in zoom-in-75 fade-in duration-300">
        <TaskAvatar taskId={data.id} type={data.type} status={data.state} execution={data} className="size-[60px]" />
        {labels.length ? (
          // Absolutely positioned so the labels never change the node size the layout was computed for.
          <div
            className="absolute top-full left-1/2 flex -translate-x-1/2 flex-col items-center text-[10px] text-muted-foreground"
            style={{ marginTop: TASK_NODE_LABEL_GAP, lineHeight: `${TASK_NODE_LABEL_LINE_HEIGHT}px` }}
          >
            {labels.map((label) => (
              <span
                key={label.path}
                title={label.title}
                className="truncate rounded-sm bg-background/80 px-1"
                style={{ maxWidth: TASK_NODE_LABEL_WIDTH }}
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
