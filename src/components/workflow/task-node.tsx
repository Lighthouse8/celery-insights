import TaskAvatar from "@components/task/task-avatar"
import { runningProgressPercent } from "@components/task/task-progress"
import { Progress } from "@components/ui/progress"
import { cn } from "@lib/utils"
import useSettingsStore from "@stores/use-settings-store"
import type { Task } from "@/types/surreal-records"
import { Link } from "@tanstack/react-router"
import React from "react"
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"

type TaskNodeType = Node<Task & Record<string, unknown>, "taskNode" | "joinedRunNode">

/** `joined`: the root of a run a member joined, from another workflow: dashed, labelled, linked to its own page. */
const TaskNode: React.FC<NodeProps<TaskNodeType> & { joined?: boolean }> = ({ data, joined }) => {
  const showTaskProgress = useSettingsStore((state) => state.showTaskProgress)
  const progressPercent = showTaskProgress ? runningProgressPercent(data) : undefined
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div
        className={cn(
          "relative animate-in zoom-in-75 fade-in duration-300",
          joined && "rounded-full border-2 border-dashed border-muted-foreground p-0.5",
        )}
      >
        <TaskAvatar
          taskId={data.id}
          type={data.type}
          status={data.state}
          execution={data}
          className={joined ? "size-[52px]" : "size-[60px]"}
        />
        {progressPercent !== undefined ? (
          // Absolutely positioned so the bar never changes the node size the layout was computed for.
          <Progress value={progressPercent} className="absolute -bottom-2 left-0 h-1" aria-label="Task progress" />
        ) : null}
        {joined ? (
          // Absolutely positioned so the label never changes the node size the layout was computed for.
          <Link
            to="/tasks/$taskId"
            params={{ taskId: data.id }}
            className="absolute top-full left-1/2 mt-3 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground hover:underline"
          >
            joined run
          </Link>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  )
}

export const JoinedRunNode: React.FC<NodeProps<TaskNodeType>> = (props) => <TaskNode {...props} joined />

type JoinedTaskNodeType = Node<{ taskId: string }, "joinedTaskNode">

/** A joined run the read couldn't load (never recorded, deleted, or not readable); the avatar links to its page. */
export const JoinedTaskNode: React.FC<NodeProps<JoinedTaskNodeType>> = ({ data }) => (
  <>
    <Handle type="target" position={Position.Left} />
    <div className="relative animate-in zoom-in-75 fade-in rounded-full border-2 border-dashed border-muted-foreground p-0.5 duration-300">
      <TaskAvatar taskId={data.taskId} type={undefined} className="size-[52px]" />
      {/* Absolutely positioned so the label never changes the node size the layout was computed for. */}
      <span className="absolute top-full left-1/2 mt-1 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground">
        joined run {data.taskId.slice(0, 8)}
      </span>
    </div>
    <Handle type="source" position={Position.Right} />
  </>
)

export default TaskNode
