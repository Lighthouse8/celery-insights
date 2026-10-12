import TaskNode, { JoinedRunNode, JoinedTaskNode } from "@components/workflow/task-node"
import { Tooltip, TooltipContent, TooltipTrigger } from "@components/ui/tooltip"
import { useIsDark } from "@hooks/use-is-dark"
import type { Task } from "@/types/surreal-records"
import { type JoinedRuns, MAX_JOINED_RUNS, MAX_LINKING_MEMBERS, NO_JOINED_RUNS } from "@lib/joined-runs"
import { Camera, Focus, Maximize2, Move, Navigation } from "lucide-react"
import { toSvg } from "html-to-image"
import React, { useCallback, useEffect, useMemo, useState } from "react"
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
  useStore,
  type Viewport,
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
  joinedRuns: JoinedRuns = NO_JOINED_RUNS,
): {
  nodes: Node[]
  edges: Edge[]
  /** Joined runs the task-workflow read left out by the MAX_JOINED_RUNS bound. */
  hiddenJoinedRuns: number
  /** Links out of expanded tasks the read left unexpanded by its MAX_EXPANDED_TASKS and depth bounds. */
  hiddenJoinedBranches: number
  /** Dashed edges to drawn nodes left out by the MAX_JOINED_RUNS edge bound. */
  hiddenJoinLinks: number
  /** For each member node, the joined-run nodes laid out in its subtree: what focusing on it frames. */
  joinedBelow: Map<string, string[]>
} => {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const taskMap = new Map<string, Task>(tasks.map((task) => [task.id, task]))
  const childMap = getChildMap(tasks)
  const visited = new Set<string>()
  // Stored children lists can be stale; only a reachable parent may adopt a parentless child, once.
  const claimed = new Set<string>([rootTaskId])
  let nextLeafRow = 0

  // Joined runs belong to other workflows, never to the tree's members, but are laid out in it: each drawn joined
  // run (chosen by the task-workflow read, then expanded into its subtree) is an extra child of the first drawn
  // task that joined it, under a dashed entry edge.
  const expanded = new Map(joinedRuns.tasks.map((task) => [task.id, task]))
  const expandedChildMap = getChildMap(joinedRuns.tasks)
  const chosen = new Set(joinedRuns.ids.filter((taskId) => !taskMap.has(taskId)))
  const walked = new Set([...joinedRuns.ids, ...joinedRuns.walked])
  // A joined run keeps its joined-run look however the layout reaches it, even as another run's child.
  const joinTargets = new Set(
    [...tasks, ...joinedRuns.tasks].flatMap((task) => task.joined_tasks ?? []).concat(joinedRuns.ids),
  )
  // Every id a member node may take, so a joined node id never collides with one laid out later.
  const nodeIds = new Set(tasks.flatMap((task) => [task.id, task.id + "-replaced"]))
  const joinedNodeIds = new Map<string, string>()
  // A member's own id may already look like a joined node id ("joined:<id>"); prefix again until it's free.
  const joinedNodeId = (taskId: string) => {
    let nodeId = joinedNodeIds.get(taskId)
    if (nodeId) return nodeId
    nodeId = JOINED_NODE_PREFIX + taskId
    while (nodeIds.has(nodeId)) nodeId = JOINED_NODE_PREFIX + nodeId
    nodeIds.add(nodeId)
    joinedNodeIds.set(taskId, nodeId)
    return nodeId
  }
  const placed = new Set<string>()
  const layoutParents = new Map<string, string>()
  // Drawn tasks in layout order, for the dashed edges once every node is placed.
  const joiners: Array<{ nodeId: string; task: Task }> = []

  // The joined runs a drawn task brings into the layout: ones the read chose (for a member) or the walk reached
  // (for an expanded task), not yet placed, and not a child of another expanded task, which places it instead.
  const joinedChildren = (task: Task, isExpanded: boolean): string[] =>
    (task.joined_tasks ?? []).filter((joinedId) => {
      if (taskMap.has(joinedId) || placed.has(joinedId)) return false
      if (!(isExpanded ? walked.has(joinedId) : chosen.has(joinedId))) return false
      const parentId = expanded.get(joinedId)?.parent_id
      if (parentId && parentId !== joinedId && expanded.has(parentId)) return false
      placed.add(joinedId)
      return true
    })

  // Every loaded joined-run task is an ordinary task node; a joined run gets the joined-run look on top.
  const visitExpanded = (taskId: string, column: number): number => {
    placed.add(taskId)
    const task = expanded.get(taskId)
    const nodeId = joinedNodeId(taskId)
    const node: Node = !task
      ? {
          id: nodeId,
          type: "joinedTaskNode",
          position: { x: column * COLUMN_WIDTH, y: 0 },
          // A run that couldn't be loaded (never recorded, deleted, or not readable) stays a placeholder.
          data: { taskId },
          connectable: false,
          deletable: false,
        }
      : { ...createNode(task, column, 0, nodeId), type: joinTargets.has(taskId) ? "joinedRunNode" : "taskNode" }
    nodes.push(node)
    const childRows: number[] = []
    if (task) {
      joiners.push({ nodeId, task })
      const joined = joinedChildren(task, true)
      // Like the workflow tree: children by parent_id, plus listed children whose parent wasn't expanded.
      const children = [
        ...(expandedChildMap.get(taskId) ?? []),
        ...task.children.flatMap((childId) => {
          const child = expanded.get(childId)
          return child && !(child.parent_id && expanded.has(child.parent_id)) ? [child] : []
        }),
      ].sort((a, b) => a.id.localeCompare(b.id))
      for (const child of children) {
        if (placed.has(child.id) || taskMap.has(child.id)) continue
        edges.push(createEdge(nodeId, joinedNodeId(child.id)))
        layoutParents.set(joinedNodeId(child.id), nodeId)
        childRows.push(visitExpanded(child.id, column + 1))
      }
      for (const joinedId of joined) {
        layoutParents.set(joinedNodeId(joinedId), nodeId)
        childRows.push(visitExpanded(joinedId, column + 1))
      }
    }
    const row = childRows.length ? (childRows[0] + childRows[childRows.length - 1]) / 2 : nextLeafRow++
    node.position.y = row * ROW_HEIGHT
    return row
  }

  const visitTask = (task: Task, column: number, extraJoined: string[] = []): number => {
    visited.add(task.id)
    const node = createNode(task, column, 0)
    nodes.push(node)
    joiners.push({ nodeId: task.id, task })
    // Claimed before the children are visited, so a run goes under its first joiner in layout order.
    const joined = [...joinedChildren(task, false), ...extraJoined]

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
        layoutParents.set(child.id, task.id)
        return visitTask(child, column + 1)
      })
    // Joined runs come after the task's own children, so they sit just below them.
    for (const joinedId of joined) {
      layoutParents.set(joinedNodeId(joinedId), task.id)
      childRows.push(visitExpanded(joinedId, column + 1))
    }
    const row = childRows.length ? (childRows[0] + childRows[childRows.length - 1]) / 2 : nextLeafRow++
    node.position.y = row * ROW_HEIGHT
    return row
  }

  let hiddenJoinLinks = 0
  const drawJoinEdges = () => {
    let edgeBudget = MAX_JOINED_RUNS
    for (const { nodeId, task } of joiners)
      for (const joinedId of task.joined_tasks ?? []) {
        // A member is a dashed edge only; a run the read cut or never drew gets none (the note counts it).
        const target = visited.has(joinedId) ? joinedId : placed.has(joinedId) ? joinedNodeId(joinedId) : undefined
        if (!target) continue
        if (!edgeBudget) {
          hiddenJoinLinks++
          continue
        }
        edgeBudget--
        edges.push(createJoinedEdge(nodeId, target))
      }
  }

  const rootTask = taskMap.get(rootTaskId)
  if (rootTask) {
    // A chosen run that no member the graph holds joined (its joiner is older than those members) hangs off the root.
    const joinedByMembers = new Set(tasks.flatMap((task) => task.joined_tasks ?? []))
    const unjoined = [...chosen].filter((taskId) => !joinedByMembers.has(taskId))
    for (const taskId of unjoined) placed.add(taskId)
    const rootRow = visitTask(rootTask, initialPosition?.x ?? 0, unjoined)
    // A chosen run whose only joiners weren't drawn (unreachable members, or a cycle) is laid out below the tree.
    for (const taskId of joinedRuns.ids)
      if (chosen.has(taskId) && !placed.has(taskId)) visitExpanded(taskId, (initialPosition?.x ?? 0) + 1)
    drawJoinEdges()
    const offset = ((initialPosition?.y ?? 0) - rootRow) * ROW_HEIGHT
    for (const node of nodes) node.position.y += offset
  }

  const joinedBelow = new Map<string, string[]>()
  for (const nodeId of joinedNodeIds.values())
    for (let ancestor = layoutParents.get(nodeId); ancestor; ancestor = layoutParents.get(ancestor))
      if (taskMap.has(ancestor)) {
        let below = joinedBelow.get(ancestor)
        if (!below) joinedBelow.set(ancestor, (below = []))
        below.push(nodeId)
      }

  return {
    nodes: nodes,
    edges: edges,
    hiddenJoinedRuns: joinedRuns.total - joinedRuns.ids.length,
    hiddenJoinedBranches: joinedRuns.cut,
    hiddenJoinLinks,
    joinedBelow,
  }
}

const listFormat = new Intl.ListFormat("en", { type: "conjunction" })

export const hiddenJoinsNote = (runs: number, links: number, branches = 0, membersCut = false): string | undefined => {
  const parts = [
    runs && `${runs} more joined run${runs === 1 ? "" : "s"}`,
    links && `${links} join link${links === 1 ? "" : "s"}`,
    branches && `${branches} joined-run branch${branches === 1 ? "" : "es"}`,
  ].filter((part): part is string => !!part)
  const lines = [
    parts.length && `${listFormat.format(parts)} not shown`,
    membersCut && `Joins from members beyond the first ${MAX_LINKING_MEMBERS.toLocaleString("en")} read aren't shown`,
  ].filter((line): line is string => !!line)
  return lines.length ? lines.join("\n") : undefined
}

const FOCUS_ZOOM = 1
// The canvas lets users zoom out at least this far, and as far as the whole graph needs to fit, however large.
const MIN_ZOOM = 0.1
const FIT_PADDING = 0.1
const ZOOM_ANIMATION_SPEED = 1000
// A task node's footprint (60px avatar); laid-out positions are unmeasured top-left corners.
const NODE_SIZE = 64

const boundsOf = (positions: XYPosition[]) => {
  const x = Math.min(...positions.map((position) => position.x))
  const y = Math.min(...positions.map((position) => position.y))
  return {
    x,
    y,
    width: Math.max(...positions.map((position) => position.x)) - x + NODE_SIZE,
    height: Math.max(...positions.map((position) => position.y)) - y + NODE_SIZE,
  }
}

/** The canvas's minimum zoom: MIN_ZOOM, or less when the whole laid-out graph needs it to fit. */
export const canvasMinZoom = (nodes: Node[], width: number, height: number): number => {
  if (!nodes.length || !width || !height) return MIN_ZOOM
  const fit = getViewportForBounds(
    boundsOf(nodes.map((node) => node.position)),
    width,
    height,
    0,
    FOCUS_ZOOM,
    FIT_PADDING,
  ).zoom
  // No floor: a fit is positive however large the graph. A canvas too small for the padding gives none.
  return fit > 0 && Number.isFinite(fit) ? Math.min(MIN_ZOOM, fit) : MIN_ZOOM
}

/**
 * The view that frames a task's node together with the joined runs laid out in its subtree, at most at FOCUS_ZOOM
 * and at least at the canvas's minimum zoom, which fits the whole graph: a task that joined nothing is centred as
 * before; one whose subtree holds joined runs shows them too.
 */
export const focusViewport = (
  nodes: Node[],
  joinedBelow: Map<string, string[]>,
  taskId: string,
  width: number,
  height: number,
): Viewport | undefined => {
  const framed = new Set([taskId, ...(joinedBelow.get(taskId) ?? [])])
  const positions = nodes.filter((node) => framed.has(node.id)).map((node) => node.position)
  if (!positions.length) return undefined
  return getViewportForBounds(
    boundsOf(positions),
    width,
    height,
    canvasMinZoom(nodes, width, height),
    FOCUS_ZOOM,
    FIT_PADDING,
  )
}

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
  joinedRuns?: JoinedRuns
}

const nodeTypes = {
  taskNode: TaskNode,
  joinedRunNode: JoinedRunNode,
  joinedTaskNode: JoinedTaskNode,
}
const FlowChart: React.FC<FlowChartProps> = ({ tasks, rootTaskId, currentTaskId, joinedRuns }) => {
  const flow = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[])
  const [locked, setLocked] = useState<boolean>(true)
  const [isInitialized, setInitialized] = useState<boolean>(false)
  const isDark = useIsDark()

  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  const graph = useMemo(() => getFlowGraph(tasks, rootTaskId, undefined, joinedRuns), [tasks, rootTaskId, joinedRuns])
  // Where the last drag left the graph's nodes; a new graph is laid out afresh.
  const [dropped, setDropped] = useState<{ graph: typeof graph; nodes: Node[] }>()
  // From the laid-out graph, or where a drag left it, not `nodes`, which changes on every measurement and selection.
  const minZoom = useMemo(
    () => canvasMinZoom(dropped?.graph === graph ? dropped.nodes : graph.nodes, width, height),
    [dropped, graph, width, height],
  )
  const onNodeDragStop = useCallback(
    (_event: unknown, _node: Node, moved: Node[]) => {
      // The store may not hold the drag's last position change yet; the dragged nodes do.
      const at = new Map(moved.map((node) => [node.id, node]))
      setDropped({ graph, nodes: flow.getNodes().map((node) => at.get(node.id) ?? node) })
    },
    [flow, graph],
  )
  const focusNode = useCallback(
    (nodeId: string, graphNodes: Node[] = flow.getNodes()) => {
      const viewport = focusViewport(graphNodes, graph.joinedBelow, nodeId, width, height)
      if (viewport) flow.setViewport(viewport, { duration: ZOOM_ANIMATION_SPEED })
      else flow.setCenter(0, 0, { zoom: FOCUS_ZOOM, duration: ZOOM_ANIMATION_SPEED })
    },
    [flow, graph, width, height],
  )

  const fitView = useCallback(() => flow.fitView({ duration: ZOOM_ANIMATION_SPEED }), [flow])

  useEffect(() => {
    setNodes(graph.nodes)
    setEdges(graph.edges)
  }, [graph, setNodes, setEdges])
  const joinsNote = useMemo(
    () =>
      hiddenJoinsNote(
        graph.hiddenJoinedRuns,
        graph.hiddenJoinLinks,
        graph.hiddenJoinedBranches,
        joinedRuns?.membersCut,
      ),
    [graph, joinedRuns],
  )

  // The first view frames the current task, with the joined runs laid out under it, once the graph is drawn and the
  // canvas has a size. A current task the graph doesn't hold gets the root centred instead, as Focus does.
  useEffect(() => {
    if (isInitialized) return
    if (currentTaskId) {
      if (!width || !height || !nodes.length) return
      focusNode(currentTaskId, nodes)
    }
    setInitialized(true)
  }, [nodes, width, height, isInitialized, currentTaskId, focusNode])

  useEffect(() => {
    if (!currentTaskId) fitView()
    else if (isInitialized) focusNode(currentTaskId)
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
      onNodeDragStop={onNodeDragStop}
      nodesDraggable={!locked}
      nodeTypes={nodeTypes}
      minZoom={minZoom}
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
        <Panel position="bottom-center" className="whitespace-pre-line text-center text-xs text-muted-foreground">
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
