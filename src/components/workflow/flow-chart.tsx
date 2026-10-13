import TaskLabelsControl from "@components/workflow/task-labels-control"
import TaskNode, { JoinedRunNode, JoinedTaskNode } from "@components/workflow/task-node"
import { Tooltip, TooltipContent, TooltipTrigger } from "@components/ui/tooltip"
import { useIsDark } from "@hooks/use-is-dark"
import { TaskNodeFieldsContext, useTaskNodeFields } from "@hooks/use-task-node-fields"
import { TASK_NODE_LABEL_GAP, TASK_NODE_LABEL_LINE_HEIGHT, TASK_NODE_LABEL_WIDTH } from "@lib/task-node-fields"
import useSettingsStore from "@stores/use-settings-store"
import type { Task } from "@/types/surreal-records"
import {
  type JoinedRuns,
  MAX_EXPANDED_TASKS,
  MAX_JOINED_RUNS,
  MAX_LINKING_MEMBERS,
  NO_JOINED_RUNS,
} from "@lib/joined-runs"
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
  Panel,
  ReactFlow,
  type ReactFlowState,
  type Rect,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  type Viewport,
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
  grid: FlowGrid = DEFAULT_GRID,
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
          position: { x: column * grid.columnWidth, y: 0 },
          // A run that couldn't be loaded (never recorded, deleted, or not readable) stays a placeholder.
          data: { taskId },
          connectable: false,
          deletable: false,
        }
      : { ...createNode(task, column, 0, grid, nodeId), type: joinTargets.has(taskId) ? "joinedRunNode" : "taskNode" }
    nodes.push(node)
    const childRows: number[] = []
    if (task) {
      joiners.push({ nodeId, task })
      const joined = joinedChildren(task, true)
      // Like the workflow tree: children by parent_id, plus listed children that name no parent. A listed child
      // naming another parent is a stale entry, whether or not that parent was expanded.
      const children = [
        ...(expandedChildMap.get(taskId) ?? []),
        ...task.children.flatMap((childId) => {
          const child = expanded.get(childId)
          return child && !child.parent_id ? [child] : []
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
    node.position.y = row * grid.rowHeight
    return row
  }

  const visitTask = (task: Task, column: number, extraJoined: string[] = []): number => {
    visited.add(task.id)
    const node = createNode(task, column, 0, grid)
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
          nodes.push(createNode(child, column + 1, row, grid, replacedId))
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
    node.position.y = row * grid.rowHeight
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
        // The edge into a run laid out under this joiner is always drawn (at most one per drawn run); only the
        // other links count against the bound.
        if (!visited.has(joinedId) && layoutParents.get(target) === nodeId) {
          edges.push(createJoinedEdge(nodeId, target))
          continue
        }
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
    const offset = ((initialPosition?.y ?? 0) - rootRow) * grid.rowHeight
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

/**
 * Node positions and edges depend only on each task's parent, its stored children (which can adopt a
 * parentless child) and the runs it joined, for members and expanded joined-run tasks alike, plus which joined
 * runs the read chose and what it left out, so a progress report or state change can update node data without
 * re-laying out the graph.
 */
const taskLinks = (tasks: Task[]) =>
  tasks
    .map(
      (task) =>
        `${task.id}<${task.parent_id ?? ""}>${[...task.children].sort().join(",")}~>${(task.joined_tasks ?? []).join(",")}`,
    )
    .sort()

export const getLayoutKey = (tasks: Task[], rootTaskId: string, joinedRuns: JoinedRuns = NO_JOINED_RUNS): string =>
  [
    rootTaskId,
    // Joined runs keep their reported order: it decides the rows their nodes take.
    ...taskLinks(tasks),
    // The chosen ids keep the read's order: it decides which joined node ids and rows they take.
    `joined:${joinedRuns.ids.join(",")}/${joinedRuns.total}/${joinedRuns.cut}`,
    // Which ids the walk reached decides which joins get a placeholder node.
    `walked:${[...joinedRuns.walked].sort().join(",")}`,
    ...taskLinks(joinedRuns.tasks).map((links) => `expanded:${links}`),
  ].join("|")

/** Swap in each node's latest task, and each joined-run node's latest record, without moving it. */
export const refreshNodeData = (nodes: Node[], tasks: Task[], joinedTasks: Task[] = []): Node[] => {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const joinedById = new Map(joinedTasks.map((task) => [task.id, task]))
  return nodes.map((node) => {
    // A placeholder is a run the read couldn't load; once it loads, the layout key changes and the graph is redrawn.
    if (node.type === "joinedTaskNode") return node
    // Duplicated nodes get a "-replaced" id and expanded joined-run tasks a "joined:" id; both keep their task in data.
    const taskId = (node.data as unknown as Task).id
    const task = tasksById.get(taskId) ?? joinedById.get(taskId)
    return task && task !== (node.data as unknown) ? { ...node, data: task as Task & Record<string, unknown> } : node
  })
}

const listFormat = new Intl.ListFormat("en", { type: "conjunction" })

export const hiddenJoinsNote = (
  runs: number,
  links: number,
  branches = 0,
  membersCut = false,
  joinsUnchecked = false,
): string | undefined => {
  const parts = [
    runs && `${runs} more joined run${runs === 1 ? "" : "s"}`,
    links && `${links} join link${links === 1 ? "" : "s"}`,
    branches && `${branches} joined-run branch${branches === 1 ? "" : "es"}`,
  ].filter((part): part is string => !!part)
  const lines = [
    parts.length && `${listFormat.format(parts)} not shown`,
    membersCut &&
      `Joins from members beyond the first ${MAX_LINKING_MEMBERS.toLocaleString("en")} that joined runs aren't shown`,
    joinsUnchecked &&
      `Joined ids beyond the first ${MAX_EXPANDED_TASKS.toLocaleString("en")} weren't checked, so there may be more joined runs not shown`,
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
  const { fields, visible } = useTaskNodeFields()
  const labelsEnabled = useSettingsStore((state) => state.taskNodeLabels)
  const grid = useMemo(() => flowGrid(visible.length), [visible.length])
  const gridRef = useRef(grid)

  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  const layoutKey = useMemo(() => getLayoutKey(tasks, rootTaskId, joinedRuns), [tasks, rootTaskId, joinedRuns])
  // Laid out again only when the layout key or the grid changes; other task updates refresh node data in place.
  const graph = useMemo(
    () => getFlowGraph(tasks, rootTaskId, undefined, joinedRuns, grid),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey, grid],
  )
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
    setNodes(graph.nodes)
    setEdges(graph.edges)
    // The drawn nodes are on this grid now; a grid change alone respaces them in place below.
    gridRef.current = grid
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, setNodes, setEdges])
  const joinsNote = useMemo(
    () =>
      hiddenJoinsNote(
        graph.hiddenJoinedRuns,
        graph.hiddenJoinLinks,
        graph.hiddenJoinedBranches,
        joinedRuns?.membersCut,
        joinedRuns?.joinsUnchecked,
      ),
    [graph, joinedRuns],
  )

  // Any other change only refreshes node data, keeping each node where it is.
  useEffect(
    () => setNodes((current) => refreshNodeData(current, tasks, joinedRuns?.tasks)),
    [tasks, joinedRuns, setNodes],
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
    else if (isInitialized) focusNode(currentTaskId)
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
        {joinsNote && (
          <Panel position="bottom-center" className="whitespace-pre-line text-center text-xs text-muted-foreground">
            {joinsNote}
          </Panel>
        )}
        <TaskMiniMap bgColor={bgColor} maskColor={hoverColor} />
      </ReactFlow>
    </TaskNodeFieldsContext.Provider>
  )
}

export default FlowChart
