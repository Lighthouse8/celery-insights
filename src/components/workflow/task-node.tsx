import TaskAvatar from "@components/task/task-avatar"
import type { Task } from "@/types/surreal-records"
import React from "react"
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"

type TaskNodeType = Node<Task & Record<string, unknown>, "taskNode">

const TaskNode: React.FC<NodeProps<TaskNodeType>> = ({ data }) => {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className="animate-in zoom-in-75 fade-in duration-300">
        <TaskAvatar taskId={data.id} type={data.type} status={data.state} execution={data} className="size-[60px]" />
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  )
}

type JoinedTaskNodeType = Node<{ taskId: string; task?: Task }, "joinedTaskNode">

/** A run from another workflow that a member joined; the avatar links to its own page. */
export const JoinedTaskNode: React.FC<NodeProps<JoinedTaskNodeType>> = ({ data }) => (
  <>
    <Handle type="target" position={Position.Left} />
    <div className="relative animate-in zoom-in-75 fade-in rounded-full border-2 border-dashed border-muted-foreground p-0.5 duration-300">
      <TaskAvatar
        taskId={data.taskId}
        type={data.task?.type}
        status={data.task?.state}
        execution={data.task}
        className="size-[52px]"
      />
      {/* Absolutely positioned so the label never changes the node size the layout was computed for. */}
      <span className="absolute top-full left-1/2 mt-1 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground">
        joined run{data.task ? "" : ` ${data.taskId.slice(0, 8)}`}
      </span>
    </div>
    <Handle type="source" position={Position.Right} />
  </>
)

export default TaskNode
