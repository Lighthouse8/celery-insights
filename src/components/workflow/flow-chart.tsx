import TaskLabelsControl from "@components/workflow/task-labels-control"
import TaskNode from "@components/workflow/task-node"
import { Tooltip, TooltipContent, TooltipTrigger } from "@components/ui/tooltip"
import { useIsDark } from "@hooks/use-is-dark"
import { TaskNodeFieldsContext, useTaskNodeFields } from "@hooks/use-task-node-fields"
import { TASK_NODE_LABEL_GAP, TASK_NODE_LABEL_LINE_HEIGHT, TASK_NODE_LABEL_WIDTH } from "@lib/task-node-fields"
import useSettingsStore from "@stores/use-settings-store"
import type { Task } from "@/types/surreal-records"
import { Camera, Focus, Maximize2, Move, Navigation } from "lucide-react"
import { toSvg } from "html-to-image"
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  ControlButton,
  Controls,
  type Edge,
  getNodesBounds,
  getViewportForBounds,
  MiniMap,
  MiniMapNode,
  type MiniMapNodeProps,
  type Node,
  ReactFlow,
  type ReactFlowState,
  type Rect,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  type XYPosition,
} from "@xyflow/react"

export interface FlowGrid {
  columnWidth: number
  rowHeight: number
}

const DEFAULT_GRID: FlowGrid = { columnWidth: 180, rowHeight: 100 }
const AVATAR_SIZE = 60

/** Task node labels hang under the avatar: columns widen to fit them, and rows grow by a line per field. */
export const flowGrid = (labelLines: number): FlowGrid =>
  labelLines
    ? {
        columnWidth: TASK_NODE_LABEL_WIDTH + 40,
        rowHeight: DEFAULT_GRID.rowHeight + labelLines * TASK_NODE_LABEL_LINE_HEIGHT,
      }
    : DEFAULT_GRID

/**
 * React Flow measures a task node as its avatar; labels overhang it on both sides and below. Widen measured
 * node bounds by that overhang so framing and image export keep the outer labels in view.
 */
export const labelledBounds = (bounds: Rect, labelLines: number): Rect => {
  if (!labelLines) return bounds
  const { side, below } = labelOverhang(labelLines)
  return { x: bounds.x - side, y: bounds.y, width: bounds.width + 2 * side, height: bounds.height + below }
}

const labelOverhang = (labelLines: number) => ({
  side: (TASK_NODE_LABEL_WIDTH - AVATAR_SIZE) / 2,
  below: TASK_NODE_LABEL_GAP + labelLines * TASK_NODE_LABEL_LINE_HEIGHT,
})

const MINIMAP_WIDTH = 200
const MINIMAP_HEIGHT = 100
const MINIMAP_OFFSET_SCALE = 5

/** Flow units per MiniMap pixel, worked out the way React Flow's MiniMap does from the nodes and the viewport. */
const miniMapViewScale = (state: ReactFlowState): number => {
  const [tx, ty, zoom] = state.transform
  const view = { x: -tx / zoom, y: -ty / zoom, x2: (state.width - tx) / zoom, y2: (state.height - ty) / zoom }
  if (state.nodes.length) {
    const nodes = getNodesBounds(state.nodes, { nodeLookup: state.nodeLookup })
    view.x = Math.min(view.x, nodes.x)
    view.y = Math.min(view.y, nodes.y)
    view.x2 = Math.max(view.x2, nodes.x + nodes.width)
    view.y2 = Math.max(view.y2, nodes.y + nodes.height)
  }
  return Math.max((view.x2 - view.x) / MINIMAP_WIDTH, (view.y2 - view.y) / MINIMAP_HEIGHT)
}

// Without labels the margin stays fixed, so the MiniMap skips the node bounds pass on every store update.
const noViewScale = () => 0

const TaskMiniMapNode = (props: MiniMapNodeProps) => {
  const labelLines = useContext(TaskNodeFieldsContext).length
  return <MiniMapNode {...props} {...labelledBounds(props, labelLines)} />
}

/**
 * The MiniMap frames nodes by their measured avatars and offers no way to widen that frame, only a uniform margin
 * in MiniMap pixels. Grow that margin by the label overhang so the labelled rectangles stay inside it.
 */
const TaskMiniMap = ({ bgColor, maskColor }: { bgColor: string; maskColor: string }) => {
  const labelLines = useContext(TaskNodeFieldsContext).length
  const viewScale = useStore(labelLines ? miniMapViewScale : noViewScale)
  const { side, below } = labelOverhang(labelLines)
  return (
    <MiniMap
      position="top-right"
      style={{ backgroundColor: bgColor, height: MINIMAP_HEIGHT, width: MINIMAP_WIDTH }}
      maskColor={maskColor}
      nodeComponent={TaskMiniMapNode}
      offsetScale={
        labelLines && viewScale ? MINIMAP_OFFSET_SCALE + Math.max(side, below) / viewScale : MINIMAP_OFFSET_SCALE
      }
      pannable
    />
  )
}

/** Moves laid-out (or dragged) nodes onto a new grid, keeping each one's place relative to the others. */
export const respaceNodes = (nodes: Node[], from: FlowGrid, to: FlowGrid): Node[] =>
  nodes.map((node) => ({
    ...node,
    position: {
      x: (node.position.x * to.columnWidth) / from.columnWidth,
      y: (node.position.y * to.rowHeight) / from.rowHeight,
    },
  }))

const createNode = (task: Task, x: number, y: number, grid: FlowGrid, nodeId?: string): Node => ({
  id: nodeId || task.id,
  type: "taskNode",
  position: { x: x * grid.columnWidth, y: y * grid.rowHeight },
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
  grid: FlowGrid = DEFAULT_GRID,
): {
  nodes: Node[]
  edges: Edge[]
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
    const node = createNode(task, column, 0, grid)
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
          nodes.push(createNode(child, column + 1, row, grid, replacedId))
          edges.push(createEdge(task.id, replacedId))
          return row
        }
        edges.push(createEdge(task.id, child.id))
        return visitTask(child, column + 1)
      })
    const row = childRows.length ? (childRows[0] + childRows[childRows.length - 1]) / 2 : nextLeafRow++
    node.position.y = row * grid.rowHeight
    return row
  }

  const rootTask = taskMap.get(rootTaskId)
  if (rootTask) {
    const rootRow = visitTask(rootTask, initialPosition?.x ?? 0)
    const offset = ((initialPosition?.y ?? 0) - rootRow) * grid.rowHeight
    for (const node of nodes) node.position.y += offset
  }

  return {
    nodes: nodes,
    edges: edges,
  }
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
}

const nodeTypes = {
  taskNode: TaskNode,
}
const FlowChart: React.FC<FlowChartProps> = ({ tasks, rootTaskId, currentTaskId }) => {
  const flow = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[])
  const [locked, setLocked] = useState<boolean>(true)
  const [isInitialized, setInitialized] = useState<boolean>(false)
  const isDark = useIsDark()
  const { fields, visible } = useTaskNodeFields()
  const labelsEnabled = useSettingsStore((state) => state.taskNodeLabels)
  const grid = useMemo(() => flowGrid(visible.length), [visible.length])
  const gridRef = useRef(grid)

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

  // Bounds need measured nodes, and on mount the store has none yet: hold the fit until React Flow measures them.
  const nodesInitialized = useNodesInitialized()
  const fitPending = useRef(false)
  // Fits now or not at all; only the mount path below holds a fit until the nodes are measured.
  const fitView = useCallback(() => {
    if (nodesInitialized)
      flow.fitBounds(labelledBounds(flow.getNodesBounds(flow.getNodes()), visible.length), {
        duration: ZOOM_ANIMATION_SPEED,
        padding: 0.1,
      })
  }, [flow, nodesInitialized, visible.length])

  useEffect(() => {
    if (!nodesInitialized || !fitPending.current) return
    fitPending.current = false
    fitView()
  }, [nodesInitialized, fitView])

  useEffect(() => {
    const graph = getFlowGraph(tasks, rootTaskId, undefined, gridRef.current)
    setNodes(graph.nodes)
    setEdges(graph.edges)
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
  }, [tasks, rootTaskId, setNodes, setEdges, flow])

  // Switching labels or fields respaces the nodes in place rather than laying the graph out again.
  useEffect(() => {
    const previous = gridRef.current
    if (previous === grid) return
    gridRef.current = grid
    setNodes((current) => respaceNodes(current, previous, grid))
  }, [grid, setNodes])

  useEffect(() => {
    fitPending.current = !currentTaskId && !nodesInitialized
    if (!currentTaskId) fitView()
    else focusNode(currentTaskId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTaskId])

  const bgColor = isDark ? "oklch(0.16 0.01 155)" : "oklch(0.95 0.015 150)"
  const hoverColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.04)"

  const handleDownloadImage = useCallback(() => {
    const nodesBounds = labelledBounds(getNodesBounds(nodes), visible.length)
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
  }, [nodes, bgColor, visible.length])

  return (
    <TaskNodeFieldsContext.Provider value={visible}>
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
          {labelsEnabled && <TaskLabelsControl fields={fields} />}
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
        <TaskMiniMap bgColor={bgColor} maskColor={hoverColor} />
      </ReactFlow>
    </TaskNodeFieldsContext.Provider>
  )
}

export default FlowChart
