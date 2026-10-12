import FlowChart from "@components/workflow/flow-chart"
import TimelineChart from "@components/workflow/timeline-chart"
import { useWorkflowTasks } from "@hooks/use-live-tasks"
import { parseTask } from "@/types/surreal-records"
import type { JoinedRuns } from "@lib/joined-runs"
import React, { useDeferredValue, useMemo } from "react"
import { ReactFlowProvider } from "@xyflow/react"
import "@xyflow/react/dist/style.css"

export enum WorkflowChartType {
  FLOWCHART = "flowchart",
  TIMELINE = "timeline",
}

interface WorkflowGraphProps {
  workflowId: string
  rootTaskId: string
  currentTaskId?: string
  chartType: WorkflowChartType
  /** Runs from other workflows that members joined; drawn in the flowchart only. */
  joinedRuns?: JoinedRuns
}

const WorkflowGraph: React.FC<WorkflowGraphProps> = ({
  chartType,
  workflowId,
  rootTaskId,
  currentTaskId,
  joinedRuns,
}) => {
  const { data: surrealTasks } = useWorkflowTasks(workflowId)
  const workflowTasks = useMemo(() => surrealTasks.map(parseTask), [surrealTasks])

  const deferredTasks = useDeferredValue(workflowTasks)
  switch (chartType) {
    case WorkflowChartType.FLOWCHART:
      return (
        <ReactFlowProvider>
          <FlowChart
            tasks={deferredTasks}
            rootTaskId={rootTaskId}
            currentTaskId={currentTaskId}
            joinedRuns={joinedRuns}
          />
        </ReactFlowProvider>
      )
    case WorkflowChartType.TIMELINE:
      return <TimelineChart tasks={deferredTasks} currentTaskId={currentTaskId} />
  }
}

export default WorkflowGraph
