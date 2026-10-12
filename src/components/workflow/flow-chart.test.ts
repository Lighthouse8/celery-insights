import { render, waitFor } from "@test-utils"
import { createTask } from "@test-fixtures"
import { MAX_JOINED_RUNS, NO_JOINED_RUNS } from "@lib/joined-runs"
import { TASK_NODE_LABEL_GAP } from "@lib/task-node-fields"
import { type Task, TaskState } from "@/types/surreal-records"
import { ReactFlowProvider } from "@xyflow/react"
import { createElement } from "react"
import FlowChart, {
  canvasMinZoom,
  flowGrid,
  focusViewport,
  getFlowGraph,
  getLayoutKey,
  hiddenJoinsNote,
  labelledBounds,
  refreshNodeData,
  respaceNodes,
} from "./flow-chart"

const viewportMoves = vi.hoisted(() => ({ setCenter: vi.fn(), setViewport: vi.fn(), fitBounds: vi.fn() }))
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>()
  // One stable wrapper per instance, as useReactFlow's own result is stable.
  const wrapped = new WeakMap<object, ReturnType<typeof actual.useReactFlow>>()
  return {
    ...actual,
    useReactFlow: () => {
      const flow = actual.useReactFlow()
      if (!wrapped.has(flow)) wrapped.set(flow, { ...flow, ...viewportMoves })
      return wrapped.get(flow)!
    },
  }
})

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => children,
}))

describe("FlowChart", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("fits the graph on mount once React Flow has measured the nodes", async () => {
    // happy-dom lays nothing out: report every observed node as a 60px avatar.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(60)
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(60)
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          const entry = { target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry
          queueMicrotask(() => this.callback([entry], this as unknown as ResizeObserver))
        }
        unobserve() {}
        disconnect() {}
      },
    )
    viewportMoves.fitBounds.mockClear()
    const tasks = [createTask({ id: "root" }), createTask({ id: "child", parent_id: "root" })]

    render(createElement(ReactFlowProvider, null, createElement(FlowChart, { tasks, rootTaskId: "root" })))

    await waitFor(() => expect(viewportMoves.fitBounds).toHaveBeenCalledTimes(1))
    expect(viewportMoves.fitBounds.mock.calls[0][0]).toEqual({ x: 0, y: 0, width: 240, height: 60 })
  })
})

describe("getFlowGraph", () => {
  it("keeps nested channel and resource branches in separate rows", () => {
    const tasks = [
      createTask({ id: "root" }),
      createTask({ id: "channel-meta", parent_id: "root" }),
      createTask({ id: "channel-linkedin", parent_id: "root" }),
      createTask({ id: "meta-resource-1", parent_id: "channel-meta" }),
      createTask({ id: "meta-resource-2", parent_id: "channel-meta" }),
      createTask({ id: "linkedin-resource-1", parent_id: "channel-linkedin" }),
      createTask({ id: "linkedin-resource-2", parent_id: "channel-linkedin" }),
      createTask({ id: "linkedin-resource-3", parent_id: "channel-linkedin" }),
      createTask({ id: "linkedin-resource-4", parent_id: "channel-linkedin" }),
      createTask({ id: "meta-hierarchy-1", parent_id: "meta-resource-1" }),
      createTask({ id: "meta-hierarchy-2", parent_id: "meta-resource-2" }),
      createTask({ id: "linkedin-hierarchy-1", parent_id: "linkedin-resource-1" }),
      createTask({ id: "linkedin-hierarchy-2", parent_id: "linkedin-resource-2" }),
      createTask({ id: "linkedin-hierarchy-3", parent_id: "linkedin-resource-3" }),
      createTask({ id: "linkedin-hierarchy-4", parent_id: "linkedin-resource-4" }),
      createTask({ id: "meta-finalize", parent_id: "meta-hierarchy-1" }),
      createTask({ id: "linkedin-metrics-1", parent_id: "linkedin-hierarchy-1" }),
      createTask({ id: "linkedin-conversions-1", parent_id: "linkedin-hierarchy-1" }),
      createTask({ id: "linkedin-metrics-2", parent_id: "linkedin-hierarchy-2" }),
      createTask({ id: "linkedin-conversions-2", parent_id: "linkedin-hierarchy-2" }),
    ]

    const { nodes, edges } = getFlowGraph(tasks, "root")
    const columns = new Map<number, number[]>()
    for (const node of nodes) {
      const rows = columns.get(node.position.x) ?? []
      rows.push(node.position.y)
      columns.set(node.position.x, rows)
    }

    expect(nodes).toHaveLength(tasks.length)
    for (const rows of columns.values()) {
      rows.sort((first, second) => first - second)
      for (let index = 1; index < rows.length; index++) {
        expect(rows[index] - rows[index - 1]).toBeGreaterThanOrEqual(100)
      }
    }
    expect(edges.filter((edge) => edge.target === "meta-finalize")).toMatchObject([
      { source: "meta-hierarchy-1", target: "meta-finalize" },
    ])
  })

  it("spaces rows and columns for task node labels", () => {
    const tasks = [
      createTask({ id: "root" }),
      createTask({ id: "child-a", parent_id: "root" }),
      createTask({ id: "child-b", parent_id: "root" }),
    ]
    const position = (nodes: { id: string; position: { x: number; y: number } }[], id: string) =>
      nodes.find((node) => node.id === id)!.position

    const compact = getFlowGraph(tasks, "root").nodes
    expect(flowGrid(0)).toEqual({ columnWidth: 180, rowHeight: 100 })
    expect(position(compact, "child-a").x).toBe(180)
    expect(position(compact, "child-b").y - position(compact, "child-a").y).toBe(100)

    const grid = flowGrid(4)
    const labelled = getFlowGraph(tasks, "root", undefined, undefined, grid).nodes
    expect(position(labelled, "child-a").x).toBe(grid.columnWidth)
    expect(position(labelled, "child-b").y - position(labelled, "child-a").y).toBe(grid.rowHeight)
    expect(grid.rowHeight).toBeGreaterThanOrEqual(100 + 4 * 14)
  })

  it("respaces laid-out and dragged nodes onto a new grid", () => {
    const tasks = [
      createTask({ id: "root" }),
      createTask({ id: "child-a", parent_id: "root" }),
      createTask({ id: "child-b", parent_id: "root" }),
    ]
    const grid = flowGrid(3)
    const compact = getFlowGraph(tasks, "root").nodes
    expect(respaceNodes(compact, flowGrid(0), grid).map((node) => node.position)).toEqual(
      getFlowGraph(tasks, "root", undefined, undefined, grid).nodes.map((node) => node.position),
    )
    const dragged = { ...compact[0], position: { x: 90, y: -50 } }
    expect(respaceNodes([dragged], flowGrid(0), grid)[0].position).toEqual({
      x: (90 * grid.columnWidth) / 180,
      y: (-50 * grid.rowHeight) / 100,
    })
  })

  it("widens node bounds by the label overhang", () => {
    const bounds = { x: 0, y: 0, width: 300, height: 160 }
    expect(labelledBounds(bounds, 0)).toBe(bounds)
    expect(labelledBounds(bounds, 3)).toEqual({ x: -80, y: 0, width: 460, height: 160 + TASK_NODE_LABEL_GAP + 3 * 14 })
  })

  it("centers a parent between child subtrees of different sizes", () => {
    const tasks = [
      createTask({ id: "root" }),
      createTask({ id: "branch-a", parent_id: "root" }),
      createTask({ id: "branch-b", parent_id: "root" }),
      createTask({ id: "leaf-a1", parent_id: "branch-a" }),
      createTask({ id: "leaf-a2", parent_id: "branch-a" }),
      createTask({ id: "leaf-a3", parent_id: "branch-a" }),
      createTask({ id: "leaf-b", parent_id: "branch-b" }),
    ]

    const { nodes } = getFlowGraph(tasks, "root", { x: 2, y: 3 })
    const root = nodes.find((node) => node.id === "root")!
    const branchA = nodes.find((node) => node.id === "branch-a")!
    const branchB = nodes.find((node) => node.id === "branch-b")!
    const branchALeaves = nodes.filter((node) => node.id.startsWith("leaf-a"))
    const branchBLeaf = nodes.find((node) => node.id === "leaf-b")!

    expect(root.position).toEqual({ x: 360, y: 300 })
    expect(root.position.y).toBe((branchA.position.y + branchB.position.y) / 2)
    expect(Math.max(...branchALeaves.map((node) => node.position.y))).toBeLessThan(branchBLeaf.position.y)
  })

  it("connects stored children when the child's parent metadata is missing", () => {
    const tasks = [
      createTask({ id: "root", children: ["channel"] }),
      createTask({ id: "channel", parent_id: "root", children: ["resource", "resource", "expired"] }),
      createTask({ id: "resource", children: ["hierarchy"] }),
      createTask({ id: "hierarchy" }),
    ]

    const { nodes, edges } = getFlowGraph(tasks, "root")

    expect(nodes.map((node) => node.id)).toEqual(["root", "channel", "resource", "hierarchy"])
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["root", "channel"],
      ["channel", "resource"],
      ["resource", "hierarchy"],
    ])
  })

  it("prefers an explicit parent over an older parent's children list", () => {
    const tasks = [
      createTask({ id: "root", children: ["child"] }),
      createTask({ id: "actual-parent", parent_id: "root", children: ["child"] }),
      createTask({ id: "child", parent_id: "actual-parent" }),
    ]
    const { edges } = getFlowGraph(tasks, "root")

    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["root", "actual-parent"],
      ["actual-parent", "child"],
    ])
  })
  it("gives a parentless child one parent when several stored children lists claim it", () => {
    const tasks = [
      createTask({ id: "root", children: ["a", "b"] }),
      createTask({ id: "a", parent_id: "root", children: ["shared"] }),
      createTask({ id: "b", parent_id: "root", children: ["shared"] }),
      createTask({ id: "shared" }),
    ]

    const { nodes, edges } = getFlowGraph(tasks, "root")

    expect(nodes.map((node) => node.id)).toEqual(["root", "a", "shared", "b"])
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["root", "a"],
      ["a", "shared"],
      ["root", "b"],
    ])
  })

  it("lets only a reachable parent claim a parentless child, whatever the row order", () => {
    const tasks = [
      createTask({ id: "orphan", children: ["child"] }),
      createTask({ id: "root", children: ["child"] }),
      createTask({ id: "child" }),
    ]

    const { nodes, edges } = getFlowGraph(tasks, "root")

    expect(nodes.map((node) => node.id)).toEqual(["root", "child"])
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([["root", "child"]])
  })

  it("ignores a parentless child that lists itself", () => {
    const tasks = [createTask({ id: "child", children: ["child"] }), createTask({ id: "root", children: ["child"] })]

    const { nodes, edges } = getFlowGraph(tasks, "root")

    expect(nodes.map((node) => node.id)).toEqual(["root", "child"])
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([["root", "child"]])
  })

  it("never re-adds the root as a child from a stale children list", () => {
    const tasks = [
      createTask({ id: "root", children: ["child"] }),
      createTask({ id: "child", parent_id: "root", children: ["root"] }),
    ]

    const { nodes, edges } = getFlowGraph(tasks, "root")

    expect(nodes.map((node) => node.id)).toEqual(["root", "child"])
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([["root", "child"]])
  })

  it("creates a single node for a root task with no children", () => {
    const root = createTask({ id: "root" })
    const { nodes, edges } = getFlowGraph([root], "root")

    expect(nodes).toHaveLength(1)
    expect(edges).toHaveLength(0)
    expect(nodes[0].id).toBe("root")
  })

  it("creates edges from parent to children", () => {
    const root = createTask({ id: "root" })
    const child1 = createTask({ id: "child-1", parent_id: "root" })
    const child2 = createTask({ id: "child-2", parent_id: "root" })

    const { nodes, edges } = getFlowGraph([root, child1, child2], "root")

    expect(nodes).toHaveLength(3)
    expect(edges).toHaveLength(2)
    expect(edges.map((e) => e.target).sort()).toEqual(["child-1", "child-2"])
    expect(edges.every((e) => e.source === "root")).toBe(true)
  })

  it("vertically centers children around parent y position", () => {
    const root = createTask({ id: "root" })
    const child1 = createTask({ id: "a-child", parent_id: "root" })
    const child2 = createTask({ id: "b-child", parent_id: "root" })
    const child3 = createTask({ id: "c-child", parent_id: "root" })

    const { nodes } = getFlowGraph([root, child1, child2, child3], "root")

    const rootNode = nodes.find((n) => n.id === "root")!
    const childNodes = nodes.filter((n) => n.id !== "root")

    // Root at y=0, 3 children: startY = 0 - (3-1)/2 = -1, so y: -1, 0, 1 (* 100px)
    expect(rootNode.position.y).toBe(0)
    const childYs = childNodes.map((n) => n.position.y).sort((a, b) => a - b)
    expect(childYs).toEqual([-100, 0, 100])
  })

  it("sorts children alphabetically by id", () => {
    const root = createTask({ id: "root" })
    const childC = createTask({ id: "c", parent_id: "root" })
    const childA = createTask({ id: "a", parent_id: "root" })
    const childB = createTask({ id: "b", parent_id: "root" })

    const { edges } = getFlowGraph([root, childC, childA, childB], "root")

    expect(edges.map((e) => e.target)).toEqual(["a", "b", "c"])
  })

  it("handles already-visited nodes by creating replaced nodes", () => {
    // Diamond DAG: root -> [c1, c2], c1 -> [shared], c2 -> [shared]
    // When DFS visits "shared" via c1 first, visiting it again via c2 creates a replaced node
    const tasks = [
      createTask({ id: "root" }),
      createTask({ id: "c1", parent_id: "root" }),
      createTask({ id: "c2", parent_id: "root" }),
      createTask({ id: "shared", parent_id: "c1" }),
      createTask({ id: "shared", parent_id: "c2" }),
    ]

    const result = getFlowGraph(tasks, "root")

    // DFS: root -> c1 (sorted first) -> shared (mark visited) -> c2 -> shared (already visited -> "shared-replaced")
    expect(result.nodes.map((n) => n.id).sort()).toEqual(["c1", "c2", "root", "shared", "shared-replaced"])
    expect(result.edges.find((e) => e.target === "shared-replaced")).toBeDefined()
  })

  it("returns empty graph when root task is missing", () => {
    const task = createTask({ id: "other" })
    const { nodes, edges } = getFlowGraph([task], "missing-root")

    expect(nodes).toHaveLength(0)
    expect(edges).toHaveLength(0)
  })

  it("handles deep trees correctly", () => {
    const tasks = [
      createTask({ id: "level-0" }),
      createTask({ id: "level-1", parent_id: "level-0" }),
      createTask({ id: "level-2", parent_id: "level-1" }),
      createTask({ id: "level-3", parent_id: "level-2" }),
    ]

    const { nodes, edges } = getFlowGraph(tasks, "level-0")

    expect(nodes).toHaveLength(4)
    expect(edges).toHaveLength(3)
    // Each level at increasing x positions (x * 180)
    const xPositions = nodes.map((n) => n.position.x)
    expect(xPositions).toEqual([0, 180, 360, 540])
  })

  it("uses initial position when provided", () => {
    const root = createTask({ id: "root" })
    const { nodes } = getFlowGraph([root], "root", { x: 5, y: 3 })

    expect(nodes[0].position.x).toBe(5 * 180)
    expect(nodes[0].position.y).toBe(3 * 100)
  })
})

describe("getLayoutKey", () => {
  const root = createTask({ id: "root" })
  const child = createTask({ id: "child", parent_id: "root", state: TaskState.STARTED })

  it("ignores progress and state, which never move a node", () => {
    const reported = {
      ...child,
      state: TaskState.SUCCESS,
      progress: { current: 4, total: 10, updated_at: new Date(), sections: [] },
    }

    expect(getLayoutKey([root, reported], "root")).toBe(getLayoutKey([root, child], "root"))
    expect(getLayoutKey([child, root], "root")).toBe(getLayoutKey([root, child], "root"))
  })

  it("changes when a task joins or moves in the tree", () => {
    const base = getLayoutKey([root, child], "root")

    expect(getLayoutKey([root, child, createTask({ id: "other", parent_id: "root" })], "root")).not.toBe(base)
    expect(getLayoutKey([root, { ...child, parent_id: "other" }], "root")).not.toBe(base)
    expect(getLayoutKey([root, child], "child")).not.toBe(base)
  })

  it("changes when a stored children list adopts a parentless task", () => {
    const orphan = createTask({ id: "orphan" })
    const before = [root, child, orphan]
    const after = [{ ...root, children: ["orphan"] }, child, orphan]

    expect(getLayoutKey(after, "root")).not.toBe(getLayoutKey(before, "root"))
    expect(getFlowGraph(after, "root").nodes.map((node) => node.id)).toContain("orphan")
    expect(getLayoutKey([{ ...root, children: ["b", "a"] }], "root")).toBe(
      getLayoutKey([{ ...root, children: ["a", "b"] }], "root"),
    )
  })

  it("changes when a member's joined runs change or a joined run loads, not when one changes state", () => {
    const joining = { ...child, joined_tasks: ["elsewhere"] }
    const elsewhere = createTask({ id: "elsewhere", workflow_id: "other", state: TaskState.STARTED })
    const chosen = { ids: ["elsewhere"], total: 1, tasks: [elsewhere], walked: ["elsewhere"], cut: 0 }
    const base = getLayoutKey([root, joining], "root", chosen)

    expect(getLayoutKey([root, { ...joining, joined_tasks: ["elsewhere", "more"] }], "root", chosen)).not.toBe(base)
    expect(getLayoutKey([root, child], "root", chosen)).not.toBe(base)
    expect(getLayoutKey([root, joining], "root")).not.toBe(base)
    expect(getLayoutKey([root, joining], "root", { ...chosen, tasks: [] })).not.toBe(base)
    expect(
      getLayoutKey([root, joining], "root", { ...chosen, tasks: [{ ...elsewhere, state: TaskState.SUCCESS }] }),
    ).toBe(base)
  })

  it("changes when the read chooses other joined runs or leaves out a different number", () => {
    const chosen = { ids: ["a", "b"], total: 2, tasks: [], walked: ["a", "b"], cut: 0 }
    const base = getLayoutKey([root], "root", chosen)

    expect(getLayoutKey([root], "root", { ...chosen, ids: ["a", "c"] })).not.toBe(base)
    expect(getLayoutKey([root], "root", { ...chosen, total: 3 })).not.toBe(base)
    expect(getLayoutKey([root], "root", { ...chosen, cut: 1 })).not.toBe(base)
    expect(getLayoutKey([root], "root", { ...chosen, walked: [...chosen.walked, "c"] })).not.toBe(base)
  })

  it("changes when an expanded joined run's structure changes, not when one of its tasks changes state", () => {
    const run = createTask({ id: "run", workflow_id: "other", children: ["step"] })
    const step = createTask({ id: "step", workflow_id: "other", parent_id: "run", state: TaskState.STARTED })
    const expanded = { ids: ["run"], total: 1, tasks: [run, step], walked: ["run", "step"], cut: 0 }
    const base = getLayoutKey([root], "root", expanded)

    expect(getLayoutKey([root], "root", { ...expanded, tasks: [run, { ...step, state: TaskState.SUCCESS }] })).toBe(
      base,
    )
    expect(getLayoutKey([root], "root", { ...expanded, tasks: [run] })).not.toBe(base)
    expect(getLayoutKey([root], "root", { ...expanded, tasks: [run, { ...step, parent_id: undefined }] })).not.toBe(
      base,
    )
    expect(getLayoutKey([root], "root", { ...expanded, tasks: [run, { ...step, joined_tasks: ["x"] }] })).not.toBe(base)
  })
})

describe("refreshNodeData", () => {
  it("keeps positions and finds tasks whose own id ends in -replaced", () => {
    const real = createTask({ id: "import-replaced" })
    const other = createTask({ id: "import" })
    const { nodes } = getFlowGraph(
      [createTask({ id: "root" }), { ...real, parent_id: "root" }, { ...other, parent_id: "root" }],
      "root",
    )
    const updated = { ...real, parent_id: "root", state: TaskState.FAILURE }

    const refreshed = refreshNodeData(nodes, [createTask({ id: "root" }), updated, { ...other, parent_id: "root" }])

    const node = refreshed.find((candidate) => candidate.id === "import-replaced")
    expect(node?.data).toBe(updated)
    expect(node?.position).toEqual(nodes.find((candidate) => candidate.id === "import-replaced")?.position)
  })

  it("swaps in a joined run's latest record without moving its node", () => {
    const root = createTask({ id: "root", joined_tasks: ["elsewhere", "missing"] })
    const elsewhere = createTask({ id: "elsewhere", workflow_id: "other", state: TaskState.STARTED })
    const { nodes } = getFlowGraph([root], "root", undefined, {
      ids: ["elsewhere", "missing"],
      total: 2,
      tasks: [elsewhere],
      walked: ["elsewhere", "missing"],
      cut: 0,
    })
    const finished = { ...elsewhere, state: TaskState.SUCCESS }

    const refreshed = refreshNodeData(nodes, [root], [finished])

    const node = refreshed.find((candidate) => candidate.id === "joined:elsewhere")
    expect(node?.data).toBe(finished)
    expect(node?.position).toEqual(nodes.find((candidate) => candidate.id === "joined:elsewhere")?.position)
    expect(refreshed.find((candidate) => candidate.id === "joined:missing")).toBe(
      nodes.find((candidate) => candidate.id === "joined:missing"),
    )
    expect(refreshed.find((candidate) => candidate.id === "root")).toBe(
      nodes.find((candidate) => candidate.id === "root"),
    )
  })
  it("refreshes a joined node by its run id, whatever node id it was given", () => {
    const root = createTask({ id: "root", joined_tasks: ["run-1"] })
    const member = createTask({ id: "joined:run-1", parent_id: "root" })
    const run = createTask({ id: "run-1", workflow_id: "other", state: TaskState.STARTED })
    const { nodes } = getFlowGraph([root, member], "root", undefined, {
      ids: ["run-1"],
      total: 1,
      tasks: [run],
      walked: ["run-1"],
      cut: 0,
    })
    const finished = { ...run, state: TaskState.SUCCESS }

    const refreshed = refreshNodeData(nodes, [root, member], [finished])

    expect(refreshed.find((node) => node.type === "joinedRunNode")?.data).toBe(finished)
    expect(refreshed.find((node) => node.id === "joined:run-1")?.data).toBe(member)
  })
})

describe("refreshNodeData expanded runs", () => {
  it("refreshes a joined run's root with progress in place, without a new layout", () => {
    const root = createTask({ id: "root", joined_tasks: ["resource"] })
    const resource = createTask({
      id: "resource",
      workflow_id: "nightly",
      state: TaskState.STARTED,
      progress: { current: 2, total: 10, sections: [], updated_at: new Date() },
    })
    const joinedRuns = { ids: ["resource"], total: 1, tasks: [resource], walked: ["resource"], cut: 0 }
    const { nodes } = getFlowGraph([root], "root", undefined, joinedRuns)
    const advanced = { ...resource, progress: { current: 7, total: 10, sections: [], updated_at: new Date() } }

    expect(getLayoutKey([root], "root", { ...joinedRuns, tasks: [advanced] })).toBe(
      getLayoutKey([root], "root", joinedRuns),
    )
    const refreshed = refreshNodeData(nodes, [root], [advanced])
    const node = refreshed.find((candidate) => candidate.id === "joined:resource")
    expect(node).toMatchObject({ type: "joinedRunNode", data: advanced })
    expect(node?.position).toEqual(nodes.find((candidate) => candidate.id === "joined:resource")?.position)
  })

  it("swaps in an expanded task's latest record without moving its node", () => {
    const root = createTask({ id: "root", joined_tasks: ["run"] })
    const run = createTask({ id: "run", workflow_id: "other", children: ["step"] })
    const step = createTask({ id: "step", workflow_id: "other", parent_id: "run", state: TaskState.STARTED })
    const { nodes } = getFlowGraph([root], "root", undefined, {
      ids: ["run"],
      total: 1,
      tasks: [run, step],
      walked: ["run", "step"],
      cut: 0,
    })
    const finished = { ...step, state: TaskState.SUCCESS }

    const refreshed = refreshNodeData(nodes, [root], [run, finished])

    const node = refreshed.find((candidate) => candidate.id === "joined:step")
    expect(node?.data).toBe(finished)
    expect(node?.position).toEqual(nodes.find((candidate) => candidate.id === "joined:step")?.position)
  })
})

const isJoinedRoot = (node: { type?: string }) => node.type === "joinedRunNode" || node.type === "joinedTaskNode"
const joinedRunId = (node: { data: unknown }) => {
  const data = node.data as { id?: string; taskId?: string }
  return data.taskId ?? data.id
}

describe("getFlowGraph joined runs", () => {
  const root = createTask({ id: "root", joined_tasks: ["elsewhere", "missing"] })
  const child = createTask({ id: "child", parent_id: "root", joined_tasks: ["elsewhere", "root"] })
  const elsewhere = createTask({ id: "elsewhere", workflow_id: "other" })
  const chosen = { ids: ["elsewhere", "missing"], total: 2, tasks: [elsewhere], walked: [], cut: 0 }

  it("draws joined runs as dashed extra nodes outside the workflow tree", () => {
    const { nodes, edges } = getFlowGraph([root, child], "root", undefined, chosen)

    const joinedNodes = nodes.filter(isJoinedRoot)
    expect(joinedNodes.map((node) => node.id)).toEqual(["joined:elsewhere", "joined:missing"])
    // A loaded run is an ordinary task node with the joined-run look.
    expect(joinedNodes[0]).toMatchObject({ type: "joinedRunNode", data: elsewhere })
    // A run that can't be loaded stays as a placeholder with only its id.
    expect(joinedNodes[1]).toMatchObject({ type: "joinedTaskNode", data: { taskId: "missing" } })
    expect(nodes.filter((node) => node.type === "taskNode").map((node) => node.id)).toEqual(["root", "child"])

    const dashed = edges.filter((edge) => edge.style?.strokeDasharray)
    expect(dashed.map((edge) => [edge.source, edge.target])).toEqual([
      ["root", "joined:elsewhere"],
      ["root", "joined:missing"],
      ["child", "joined:elsewhere"],
      ["child", "root"],
    ])
    expect(edges.find((edge) => edge.id === "root>child")?.style).toBeUndefined()
  })

  it("lays each joined run out as a child of its joiner, inside the joiner's subtree", () => {
    // Fyr's shape: cache_all -> cache_by_organization -> two channel tasks that joined runs.
    const all = createTask({ id: "all" })
    const organization = createTask({ id: "organization", parent_id: "all" })
    const meta = createTask({ id: "meta", parent_id: "organization", joined_tasks: ["run-1", "run-2"] })
    const linkedin = createTask({ id: "linkedin", parent_id: "organization", joined_tasks: ["run-3"] })
    const runs = [
      createTask({ id: "run-1", workflow_id: "nightly", children: ["step-1a", "step-1b"] }),
      createTask({ id: "step-1a", workflow_id: "nightly", parent_id: "run-1" }),
      createTask({ id: "step-1b", workflow_id: "nightly", parent_id: "run-1" }),
      createTask({ id: "run-2", workflow_id: "nightly" }),
      createTask({ id: "run-3", workflow_id: "nightly", children: ["step-3a"] }),
      createTask({ id: "step-3a", workflow_id: "nightly", parent_id: "run-3" }),
    ]
    const { nodes, edges } = getFlowGraph([all, organization, meta, linkedin], "all", undefined, {
      ids: ["run-1", "run-2", "run-3"],
      total: 3,
      tasks: runs,
      walked: runs.map((task) => task.id),
      cut: 0,
    })
    const position = (id: string) => nodes.find((node) => node.id === id)!.position
    const span = (ids: string[]) => {
      const rows = ids.map((id) => position(id).y)
      return [Math.min(...rows), Math.max(...rows)]
    }

    for (const [joiner, run] of [
      ["meta", "joined:run-1"],
      ["meta", "joined:run-2"],
      ["linkedin", "joined:run-3"],
    ]) {
      expect(position(run).x).toBe(position(joiner).x + 180)
      expect(edges).toContainEqual(expect.objectContaining({ source: joiner, target: run }))
    }
    const metaSpan = span(["meta", "joined:run-1", "joined:step-1a", "joined:step-1b", "joined:run-2"])
    const linkedinSpan = span(["linkedin", "joined:run-3", "joined:step-3a"])
    // The joiner sits within its joined runs' rows, and sibling subtrees don't overlap.
    expect(position("meta").y).toBeGreaterThanOrEqual(position("joined:run-1").y)
    expect(position("meta").y).toBeLessThanOrEqual(position("joined:run-2").y)
    expect(metaSpan[1] < linkedinSpan[0] || linkedinSpan[1] < metaSpan[0]).toBe(true)
    const spots = nodes.map((node) => `${node.position.x},${node.position.y}`)
    expect(new Set(spots).size).toBe(spots.length)
  })

  it("frames a task with the joined runs laid out under it, and centres one that joined nothing", () => {
    const all = createTask({ id: "all" })
    const meta = createTask({ id: "meta", parent_id: "all", joined_tasks: ["run-1"] })
    const quiet = createTask({ id: "quiet", parent_id: "all" })
    const runs = [
      createTask({ id: "run-1", workflow_id: "nightly" }),
      ...Array.from({ length: 11 }, (_, index) =>
        createTask({ id: `step-${index}`, workflow_id: "nightly", parent_id: "run-1" }),
      ),
    ]
    const graph = getFlowGraph([all, meta, quiet], "all", undefined, {
      ids: ["run-1"],
      total: 1,
      tasks: runs,
      walked: runs.map((task) => task.id),
      cut: 0,
    })
    expect(graph.joinedBelow.get("all")).toHaveLength(runs.length)
    expect(graph.joinedBelow.get("meta")).toHaveLength(runs.length)
    expect(graph.joinedBelow.get("quiet")).toBeUndefined()

    const [width, height] = [800, 400]
    const onScreen = (id: string, viewport: { x: number; y: number; zoom: number }) => {
      const { x, y } = graph.nodes.find((node) => node.id === id)!.position
      return [x * viewport.zoom + viewport.x, y * viewport.zoom + viewport.y]
    }
    const framed = focusViewport(graph.nodes, graph.joinedBelow, "all", width, height)!
    for (const id of ["all", ...graph.joinedBelow.get("all")!]) {
      const [x, y] = onScreen(id, framed)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(height)
    }
    const centred = focusViewport(graph.nodes, graph.joinedBelow, "quiet", width, height)!
    expect(centred.zoom).toBe(1)
    const [x, y] = onScreen("quiet", centred)
    expect([x + 32, y + 32]).toEqual([width / 2, height / 2])
  })

  it("lists, for every member, each joined-run node laid out in its subtree once and in layout order", () => {
    const root = createTask({ id: "root" })
    const quiet = createTask({ id: "quiet", parent_id: "root" })
    const middle = createTask({ id: "middle", parent_id: "root" })
    const joiner = createTask({ id: "joiner", parent_id: "middle", joined_tasks: ["run-1", "run-2"] })
    const runs = [
      createTask({ id: "run-1", workflow_id: "nightly" }),
      createTask({ id: "step", workflow_id: "nightly", parent_id: "run-1" }),
      createTask({ id: "run-2", workflow_id: "nightly" }),
    ]
    const { joinedBelow } = getFlowGraph([root, quiet, middle, joiner], "root", undefined, {
      ids: ["run-1", "run-2"],
      total: 2,
      tasks: runs,
      walked: runs.map((task) => task.id),
      cut: 0,
    })

    const below = ["joined:run-1", "joined:step", "joined:run-2"]
    expect(Object.fromEntries(joinedBelow)).toEqual({ root: below, middle: below, joiner: below })
  })

  it("zooms out as far as a tall joined-run subtree needs to frame it, and lets the canvas go that far", () => {
    // Run A's 100 leaf children push run B about 10,000px below the joiner.
    const joiner = createTask({ id: "joiner", joined_tasks: ["run-a", "run-b"] })
    const runs = [
      createTask({ id: "run-a", workflow_id: "nightly" }),
      ...Array.from({ length: 100 }, (_, index) =>
        createTask({ id: `leaf-${String(index).padStart(3, "0")}`, workflow_id: "nightly", parent_id: "run-a" }),
      ),
      createTask({ id: "run-b", workflow_id: "nightly" }),
    ]
    const graph = getFlowGraph([joiner], "joiner", undefined, {
      ids: ["run-a", "run-b"],
      total: 2,
      tasks: runs,
      walked: runs.map((task) => task.id),
      cut: 0,
    })
    const [width, height] = [800, 400]

    const viewport = focusViewport(graph.nodes, graph.joinedBelow, "joiner", width, height)!
    for (const id of ["joiner", ...graph.joinedBelow.get("joiner")!]) {
      const { x, y } = graph.nodes.find((node) => node.id === id)!.position
      expect(y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(0)
      expect((y + 64) * viewport.zoom + viewport.y).toBeLessThanOrEqual(height)
      expect(x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(0)
      expect((x + 64) * viewport.zoom + viewport.x).toBeLessThanOrEqual(width)
    }
    expect(viewport.zoom).toBeLessThan(0.1)
    expect(canvasMinZoom(graph.nodes, width, height)).toBeLessThanOrEqual(viewport.zoom)
  })

  it("frames a joined run below thousands of members, however far out that takes the zoom", () => {
    // 9,999 leaf members put the joined run about 500,000px below the root, over 1,000 times a 400px canvas.
    const root = createTask({ id: "root", joined_tasks: ["run"] })
    const members = Array.from({ length: 9999 }, (_, index) =>
      createTask({ id: `member-${String(index).padStart(4, "0")}`, parent_id: "root" }),
    )
    const run = createTask({ id: "run", workflow_id: "nightly" })
    const graph = getFlowGraph([root, ...members], "root", undefined, {
      ids: ["run"],
      total: 1,
      tasks: [run],
      walked: ["run"],
      cut: 0,
    })
    const [width, height] = [800, 400]

    const viewport = focusViewport(graph.nodes, graph.joinedBelow, "root", width, height)!
    for (const id of ["root", "joined:run"]) {
      const { x, y } = graph.nodes.find((node) => node.id === id)!.position
      expect(y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(0)
      expect((y + 64) * viewport.zoom + viewport.y).toBeLessThanOrEqual(height)
      expect(x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(0)
      expect((x + 64) * viewport.zoom + viewport.x).toBeLessThanOrEqual(width)
    }
    expect(viewport.zoom).toBeLessThan(0.001)
    expect(canvasMinZoom(graph.nodes, width, height)).toBeGreaterThan(0)
    expect(canvasMinZoom(graph.nodes, width, height)).toBeLessThanOrEqual(viewport.zoom)
  })

  it("keeps the default minimum zoom without a graph or a canvas size", () => {
    expect(canvasMinZoom([], 800, 400)).toBe(0.1)
    const { nodes } = getFlowGraph([createTask({ id: "root" })], "root")
    expect(canvasMinZoom(nodes, 0, 0)).toBe(0.1)
    expect(canvasMinZoom(nodes, 10, 10)).toBe(0.1)
  })

  it("draws exactly the runs the read chose, even ones its members don't link to", () => {
    // 10,001 members: the graph holds the newest 10,000, where the root joins b-000..b-099; the oldest, which
    // only the read sees, joins a-run. The read's first 100 ids are a-run and b-000..b-098.
    const bIds = Array.from({ length: MAX_JOINED_RUNS }, (_, index) => `b-${String(index).padStart(3, "0")}`)
    const tasks = [
      createTask({ id: "root", joined_tasks: bIds }),
      ...Array.from({ length: 9999 }, (_, index) => createTask({ id: `member-${index}`, parent_id: "root" })),
    ]
    const aRun = createTask({ id: "a-run", workflow_id: "other" })

    const { nodes, edges, hiddenJoinedRuns } = getFlowGraph(tasks, "root", undefined, {
      ids: ["a-run", ...bIds.slice(0, -1)],
      total: MAX_JOINED_RUNS + 1,
      walked: [],
      cut: 0,
      tasks: [aRun],
    })

    const joinedNodes = nodes.filter(isJoinedRoot)
    expect(joinedNodes.map(joinedRunId).sort()).toEqual(["a-run", ...bIds.slice(0, -1)])
    expect(joinedNodes.find((node) => node.id === "joined:a-run")).toMatchObject({ type: "joinedRunNode", data: aRun })
    expect(edges.some((edge) => edge.target === "joined:b-099")).toBe(false)
    expect(edges.filter((edge) => edge.style?.strokeDasharray)).toHaveLength(MAX_JOINED_RUNS - 1)
    expect(hiddenJoinedRuns).toBe(1)
  })

  it("bounds dashed edges when many members join the same run", () => {
    const tasks = [
      createTask({ id: "root" }),
      ...Array.from({ length: 300 }, (_, index) =>
        createTask({ id: `child-${index}`, parent_id: "root", joined_tasks: ["shared", "root"] }),
      ),
    ]

    const { nodes, edges, hiddenJoinedRuns, hiddenJoinLinks } = getFlowGraph(tasks, "root", undefined, {
      ids: ["shared"],
      total: 1,
      walked: [],
      cut: 0,
      tasks: [],
    })

    expect(nodes.filter(isJoinedRoot)).toHaveLength(1)
    expect(edges.filter((edge) => edge.style?.strokeDasharray)).toHaveLength(MAX_JOINED_RUNS)
    expect(hiddenJoinedRuns).toBe(0)
    expect(hiddenJoinLinks).toBe(600 - MAX_JOINED_RUNS)
    expect(hiddenJoinsNote(hiddenJoinedRuns, hiddenJoinLinks)).toBe("500 join links not shown")
  })

  it("notes left-out joined runs and join links together", () => {
    expect(hiddenJoinsNote(0, 0)).toBeUndefined()
    expect(hiddenJoinsNote(1, 0)).toBe("1 more joined run not shown")
    expect(hiddenJoinsNote(50, 1)).toBe("50 more joined runs and 1 join link not shown")
  })

  it("gives joined nodes ids no member node has", () => {
    const tasks = [
      createTask({ id: "root", joined_tasks: ["run-1", "joined:run-1"] }),
      createTask({ id: "joined:run-1", parent_id: "root" }),
      createTask({ id: "joined:joined:run-1", parent_id: "root" }),
    ]

    const { nodes, edges } = getFlowGraph(tasks, "root", undefined, {
      ids: ["run-1"],
      total: 1,
      tasks: [],
      walked: [],
      cut: 0,
    })

    const ids = nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    const runNode = nodes.find(isJoinedRoot)
    expect(runNode?.data).toEqual({ taskId: "run-1" })
    expect(ids).toContain("joined:joined:joined:run-1")
    const dashed = edges.filter((edge) => edge.style?.strokeDasharray).map((edge) => [edge.source, edge.target])
    expect(dashed).toEqual([
      ["root", runNode?.id],
      ["root", "joined:run-1"],
    ])
  })

  describe("expanded runs", () => {
    const member = createTask({ id: "root", joined_tasks: ["resource"] })
    const memberChild = createTask({ id: "child", parent_id: "root" })
    // Shapes from Fyr: the hierarchy task also lists finalize, whose parent is the resource task.
    const resource = createTask({ id: "resource", workflow_id: "nightly", children: ["hierarchy", "finalize"] })
    const hierarchy = createTask({
      id: "hierarchy",
      workflow_id: "nightly",
      parent_id: "resource",
      children: ["finalize", "metrics"],
    })
    const finalize = createTask({
      id: "finalize",
      workflow_id: "nightly",
      parent_id: "resource",
      children: ["fail", "resource"],
    })
    const fail = createTask({ id: "fail", workflow_id: "nightly", parent_id: "finalize" })
    const metrics = createTask({
      id: "metrics",
      workflow_id: "nightly",
      parent_id: "hierarchy",
      joined_tasks: ["nested", "root", "gone", "cut-run"],
    })
    const nested = createTask({ id: "nested", workflow_id: "nested", children: ["nested-child"] })
    const nestedChild = createTask({ id: "nested-child", workflow_id: "nested", parent_id: "nested" })
    const expanded = {
      ids: ["resource"],
      total: 1,
      tasks: [resource, hierarchy, finalize, fail, metrics, nested, nestedChild],
      // "gone" was walked but has no record; "cut-run" was never walked (cut by the bounds).
      walked: ["resource", "hierarchy", "finalize", "fail", "metrics", "nested", "nested-child", "gone"],
      cut: 0,
    }
    const graph = getFlowGraph([member, memberChild], "root", undefined, expanded)
    const node = (id: string) => graph.nodes.find((candidate) => candidate.id === id)
    const solid = graph.edges.filter((edge) => !edge.style?.strokeDasharray).map((edge) => [edge.source, edge.target])
    const dashed = graph.edges.filter((edge) => edge.style?.strokeDasharray).map((edge) => [edge.source, edge.target])

    it("draws a joined run's subtree as task nodes under its joined-run root", () => {
      expect(node("joined:resource")).toMatchObject({ type: "joinedRunNode", data: resource })
      for (const task of [hierarchy, finalize, fail, metrics])
        expect(node(`joined:${task.id}`)).toMatchObject({ type: "taskNode", data: task })
      expect(solid).toEqual(
        expect.arrayContaining([
          ["joined:resource", "joined:finalize"],
          ["joined:resource", "joined:hierarchy"],
          ["joined:finalize", "joined:fail"],
          ["joined:hierarchy", "joined:metrics"],
        ]),
      )
      // Finalize hangs under its parent only, though the hierarchy task lists it too.
      expect(solid).not.toContainEqual(["joined:hierarchy", "joined:finalize"])
      expect(node("joined:hierarchy")!.position.x).toBe(node("joined:resource")!.position.x + 180)
      expect(node("joined:resource")!.position.x).toBe(node("root")!.position.x + 180)
    })

    it("enters each expanded run by a dashed edge and expands runs it joined", () => {
      expect(dashed).toEqual([
        ["root", "joined:resource"],
        ["joined:metrics", "joined:nested"],
        ["joined:metrics", "root"],
        ["joined:metrics", "joined:gone"],
      ])
      expect(node("joined:nested")).toMatchObject({ type: "joinedRunNode", data: nested })
      expect(node("joined:nested-child")).toMatchObject({ type: "taskNode", data: nestedChild })
      expect(solid).toContainEqual(["joined:nested", "joined:nested-child"])
      // A run the walk reached but couldn't load stays a placeholder; one it never reached isn't drawn.
      expect(node("joined:gone")).toMatchObject({ type: "joinedTaskNode", data: { taskId: "gone" } })
      expect(node("joined:cut-run")).toBeUndefined()
    })

    it("keeps the joined-run look on a joined run another expansion reaches first as a child", () => {
      const joiner = createTask({ id: "root", joined_tasks: ["a", "b"] })
      const a = createTask({ id: "a", workflow_id: "other", children: ["b"] })
      const b = createTask({ id: "b", workflow_id: "other", parent_id: "a" })
      const both = getFlowGraph([joiner], "root", undefined, {
        ids: ["a", "b"],
        total: 2,
        tasks: [a, b],
        walked: ["a", "b"],
        cut: 0,
      })
      const bNode = both.nodes.find((candidate) => candidate.id === "joined:b")

      expect(bNode).toMatchObject({ type: "joinedRunNode", data: b })
      expect(both.edges.map((edge) => [edge.source, edge.target])).toEqual(
        expect.arrayContaining([
          ["joined:a", "joined:b"],
          ["root", "joined:b"],
        ]),
      )
    })

    it("keeps the members' own structure and gives every node its own spot", () => {
      const membersOnly = getFlowGraph([member, memberChild], "root")
      const memberNodes = graph.nodes.filter((candidate) => ["root", "child"].includes(candidate.id))
      expect(memberNodes.map((candidate) => [candidate.id, candidate.position.x])).toEqual(
        membersOnly.nodes.map((candidate) => [candidate.id, candidate.position.x]),
      )
      expect(graph.edges.filter((edge) => ["root", "child"].includes(edge.target))).toEqual(
        expect.arrayContaining(membersOnly.edges),
      )
      const spots = graph.nodes.map((candidate) => `${candidate.position.x},${candidate.position.y}`)
      expect(new Set(spots).size).toBe(spots.length)
    })

    it("notes the branches the read left unexpanded", () => {
      const cut = getFlowGraph([member], "root", undefined, { ...expanded, total: 2, cut: 3 })
      expect(cut.hiddenJoinedBranches).toBe(3)
      expect(hiddenJoinsNote(cut.hiddenJoinedRuns, 2, cut.hiddenJoinedBranches)).toBe(
        "1 more joined run, 2 join links, and 3 joined-run branches not shown",
      )
    })
  })

  it("draws nothing extra without joins", () => {
    const { nodes, edges } = getFlowGraph([createTask({ id: "root" })], "root", undefined, NO_JOINED_RUNS)
    expect(nodes).toHaveLength(1)
    expect(edges).toHaveLength(0)
  })
})

describe("FlowChart first view", () => {
  const chart = (tasks: Task[], currentTaskId: string) =>
    createElement(ReactFlowProvider, null, createElement(FlowChart, { tasks, rootTaskId: "root", currentTaskId }))

  it("centres the root when the graph doesn't hold the current task, and doesn't jump once it arrives", () => {
    viewportMoves.setCenter.mockClear()
    viewportMoves.setViewport.mockClear()
    const root = createTask({ id: "root" })
    const { rerender } = render(chart([], "old"))
    expect(viewportMoves.setCenter).not.toHaveBeenCalled()

    rerender(chart([root], "old"))
    expect(viewportMoves.setCenter).toHaveBeenCalledOnce()
    expect(viewportMoves.setCenter.mock.calls[0].slice(0, 2)).toEqual([0, 0])

    rerender(chart([root, createTask({ id: "old", parent_id: "root" })], "old"))
    expect(viewportMoves.setViewport).not.toHaveBeenCalled()

    rerender(chart([root, createTask({ id: "old", parent_id: "root" })], "root"))
    expect(viewportMoves.setViewport).toHaveBeenCalledOnce()
  })
})
