import TaskNode, { JoinedTaskNode } from "@components/workflow/task-node"
import { Tooltip, TooltipContent, TooltipTrigger } from "@components/ui/tooltip"
import { useIsDark } from "@hooks/use-is-dark"
import type { Task } from "@/types/surreal-records"
import { joinedRunIds, MAX_JOINED_RUNS } from "@lib/joined-runs"
import { Camera, Focus, Maximize2, Move, Navigation } from "lucide-react"
import { toSvg } from "html-to-image"
import React, { useCallback, useEffect, useState } from "react"
import {
  Background,
  ControlButton,
  Controls,
  type Edge,
  getNodesBounds,
  getViewportForBounds,
  MiniMap,
  type Node,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type XYPosition,
} from "@xyflow/react"

const COLUMN_WIDTH = 180
const ROW_HEIGHT = 100

const createNode = (task: Task, x: number, y: number, nodeId?: string): Node => ({
  id: nodeId || task.id,
  type: "taskNode",
  position: { x: x * COLUMN_WIDTH, y: y * ROW_HEIGHT },
  data: task as Task & Record<string, unknown>,
  connectable: false,
  deletable: false,
})

function createEdge(sourceId: string, targetId: string): Edge {
  return {
    id: `${sourceId}>${targetId}`,
    source: sourceId,
    target: targetId,
    type: "simplebezier",
    deletable: false,
  }
}

const JOINED_NODE_PREFIX = "joined:"

const createJoinedEdge = (sourceId: string, targetId: string): Edge => ({
  ...createEdge(sourceId, targetId),
  id: `${sourceId}~>${targetId}`,
  style: { strokeDasharray: "6 4" },
})

const getChildMap = (tasks: Task[]): Map<string, Task[]> => {
  const map = new Map<string, Task[]>()
  for (const task of tasks)
    if (task.parent_id) {
      const id = task.parent_id
      if (!map.has(id)) map.set(id, [])

      map.get(id)?.push(task)
    }
  return map
}

export const getFlowGraph = (
  tasks: Task[],
  rootTaskId: string,
  initialPosition?: XYPosition,
  joinedTasks: Task[] = [],
): {
  nodes: Node[]
  edges: Edge[]
  /** Joined runs left out of the view by the MAX_JOINED_RUNS bounds. */
  hiddenJoinedRuns: number
  /** Dashed edges to drawn nodes left out by the MAX_JOINED_RUNS edge bound. */
  hiddenJoinLinks: number
} => {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const taskMap = new Map<string, Task>(tasks.map((task) => [task.id, task]))
  const childMap = getChildMap(tasks)
  const visited = new Set<string>()
  // Stored children lists can be stale; only a reachable parent may adopt a parentless child, once.
  const claimed = new Set<string>([rootTaskId])
  let nextLeafRow = 0

  const visitTask = (task: Task, column: number): number => {
    visited.add(task.id)
    const node = createNode(task, column, 0)
    nodes.push(node)

    const children = [...(childMap.get(task.id) || [])]
    for (const childId of task.children) {
      const child = taskMap.get(childId)
      if (!child || child.parent_id || claimed.has(childId)) continue
      claimed.add(childId)
      children.push(child)
    }

    const childRows = children
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((child) => {
        if (visited.has(child.id)) {
          const replacedId = child.id + "-replaced"
          const row = nextLeafRow++
          nodes.push(createNode(child, column + 1, row, replacedId))
          edges.push(createEdge(task.id, replacedId))
          return row
        }
        edges.push(createEdge(task.id, child.id))
        return visitTask(child, column + 1)
      })
    const row = childRows.length ? (childRows[0] + childRows[childRows.length - 1]) / 2 : nextLeafRow++
    node.position.y = row * ROW_HEIGHT
    return row
  }

  // Joined runs belong to other workflows: drawn after the tree, never part of it. A view draws at most
  // MAX_JOINED_RUNS dashed edges, and only the runs the task-workflow read loads (joinedRunIds).
  let hiddenJoinedRuns = 0
  let hiddenJoinLinks = 0
  const addJoinedRuns = () => {
    const { ids, total } = joinedRunIds(tasks)
    const drawable = new Set(ids)
    const joinedById = new Map(joinedTasks.map((task) => [task.id, task]))
    const joinedNodes = new Map<string, Node>()
    const nodeIds = new Set(nodes.map((node) => node.id))
    // A member's own id may already look like a joined node id ("joined:<id>"); prefix again until it's free.
    const joinedNodeId = (joinedId: string) => {
      let nodeId = JOINED_NODE_PREFIX + joinedId
      while (nodeIds.has(nodeId)) nodeId = JOINED_NODE_PREFIX + nodeId
      nodeIds.add(nodeId)
      return nodeId
    }
    let edgeBudget = MAX_JOINED_RUNS
    for (const node of nodes) {
      const task = node.data as unknown as Task
      // A "-replaced" duplicate shares its task; only the task's own node draws the joins.
      if (node.id !== task.id) continue
      for (const joinedId of task.joined_tasks ?? []) {
        if (!visited.has(joinedId) && !drawable.has(joinedId)) continue
        if (!edgeBudget) {
          hiddenJoinLinks++
          continue
        }
        edgeBudget--
        if (visited.has(joinedId)) {
          edges.push(createJoinedEdge(task.id, joinedId))
          continue
        }
        let joinedNode = joinedNodes.get(joinedId)
        if (!joinedNode) {
          joinedNode = {
            id: joinedNodeId(joinedId),
            type: "joinedTaskNode",
            position: { x: node.position.x + COLUMN_WIDTH, y: nextLeafRow++ * ROW_HEIGHT },
            // A run that couldn't be loaded (never recorded, deleted, or not readable) stays a placeholder.
            data: { taskId: joinedId, task: joinedById.get(joinedId) },
            connectable: false,
            deletable: false,
          }
          joinedNodes.set(joinedId, joinedNode)
        }
        edges.push(createJoinedEdge(task.id, joinedNode.id))
      }
    }
    nodes.push(...joinedNodes.values())
    hiddenJoinedRuns = total - joinedNodes.size
  }

  const rootTask = taskMap.get(rootTaskId)
  if (rootTask) {
    const rootRow = visitTask(rootTask, initialPosition?.x ?? 0)
    addJoinedRuns()
    const offset = ((initialPosition?.y ?? 0) - rootRow) * ROW_HEIGHT
    for (const node of nodes) node.position.y += offset
  }

  return {
    nodes: nodes,
    edges: edges,
    hiddenJoinedRuns,
    hiddenJoinLinks,
  }
}

export const hiddenJoinsNote = (runs: number, links: number): string | undefined => {
  const parts = [
    runs && `${runs} more joined run${runs === 1 ? "" : "s"}`,
    links && `${links} join link${links === 1 ? "" : "s"}`,
  ].filter(Boolean)
  return parts.length ? `${parts.join(" and ")} not shown` : undefined
}

const FOCUS_ZOOM = 1
const ZOOM_ANIMATION_SPEED = 1000

const EXPORT_IMAGE_WIDTH = 1920
const EXPORT_IMAGE_HEIGHT = 1080

function downloadImage(dataUrl: string) {
  const a = document.createElement("a")

  a.setAttribute("download", "celery-insights-export.svg")
  a.setAttribute("href", dataUrl)
  a.click()
}

interface FlowChartProps {
  tasks: Task[]
  rootTaskId: string
  currentTaskId?: string
  joinedTasks?: Task[]
}

const nodeTypes = {
  taskNode: TaskNode,
  joinedTaskNode: JoinedTaskNode,
}
const FlowChart: React.FC<FlowChartProps> = ({ tasks, rootTaskId, currentTaskId, joinedTasks }) => {
  const flow = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[])
  const [locked, setLocked] = useState<boolean>(true)
  const [isInitialized, setInitialized] = useState<boolean>(false)
  const [joinsNote, setJoinsNote] = useState<string>()
  const isDark = useIsDark()

  const focusNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((node) => node.id === nodeId)
      if (node)
        flow.setCenter(node.position.x, node.position.y, {
          zoom: FOCUS_ZOOM,
          duration: ZOOM_ANIMATION_SPEED,
        })
      else flow.setCenter(0, 0, { zoom: FOCUS_ZOOM, duration: ZOOM_ANIMATION_SPEED })
    },
    [flow, nodes],
  )

  const fitView = useCallback(() => flow.fitView({ duration: ZOOM_ANIMATION_SPEED }), [flow])

  useEffect(() => {
    const graph = getFlowGraph(tasks, rootTaskId, undefined, joinedTasks)
    setNodes(graph.nodes)
    setEdges(graph.edges)
    setJoinsNote(hiddenJoinsNote(graph.hiddenJoinedRuns, graph.hiddenJoinLinks))
    if (!isInitialized && currentTaskId) {
      const node = graph.nodes.find((node) => node.id === currentTaskId)
      if (node)
        flow.setCenter(node.position.x, node.position.y, {
          zoom: FOCUS_ZOOM,
          duration: ZOOM_ANIMATION_SPEED,
        })
    }
    setInitialized(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, rootTaskId, joinedTasks, setNodes, setEdges, flow])

  useEffect(() => {
    if (!currentTaskId) fitView()
    else focusNode(currentTaskId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTaskId])

  const bgColor = isDark ? "oklch(0.16 0.01 155)" : "oklch(0.95 0.015 150)"
  const hoverColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.04)"

  const handleDownloadImage = useCallback(() => {
    const nodesBounds = getNodesBounds(nodes)
    const viewport = getViewportForBounds(nodesBounds, EXPORT_IMAGE_WIDTH, EXPORT_IMAGE_HEIGHT, 0.5, 2, 0)
    const element = document.querySelector(".react-flow__viewport") as HTMLElement
    if (!element) return

    toSvg(element, {
      width: EXPORT_IMAGE_WIDTH,
      height: EXPORT_IMAGE_HEIGHT,
      style: {
        backgroundColor: bgColor,
        width: `${EXPORT_IMAGE_WIDTH}px`,
        height: `${EXPORT_IMAGE_HEIGHT}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    }).then(downloadImage)
  }, [nodes, bgColor])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodesDraggable={!locked}
      nodeTypes={nodeTypes}
    >
      <Background />
      <Controls showZoom={false} showFitView={false} showInteractive={false}>
        <ControlButton onClick={() => setLocked((locked) => !locked)}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center justify-center">
                {locked ? <Move className="size-3" /> : <Navigation className="size-3" />}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{locked ? "Move nodes" : "Move camera"}</TooltipContent>
          </Tooltip>
        </ControlButton>
        <ControlButton onClick={() => fitView()}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center justify-center">
                <Maximize2 className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">Fit view</TooltipContent>
          </Tooltip>
        </ControlButton>
        <ControlButton onClick={() => currentTaskId && focusNode(currentTaskId)} disabled={!currentTaskId}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center justify-center">
                <Focus className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">Focus current task</TooltipContent>
          </Tooltip>
        </ControlButton>
        <ControlButton onClick={() => handleDownloadImage()}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center justify-center">
                <Camera className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">Save as image</TooltipContent>
          </Tooltip>
        </ControlButton>
      </Controls>
      {joinsNote && (
        <Panel position="bottom-center" className="text-xs text-muted-foreground">
          {joinsNote}
        </Panel>
      )}
      <MiniMap
        position="top-right"
        style={{ backgroundColor: bgColor, height: 100, width: 200 }}
        maskColor={hoverColor}
        pannable
      />
    </ReactFlow>
  )
}

export default FlowChart
