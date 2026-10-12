import { createTask } from "@test-fixtures"
import { joinedRunIds, MAX_JOINED_RUNS } from "@lib/joined-runs"
import { TaskState } from "@/types/surreal-records"
import { getFlowGraph, getLayoutKey, hiddenJoinsNote, refreshNodeData } from "./flow-chart"

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
    const reported = { ...child, state: TaskState.SUCCESS, progress: { current: 4, total: 10, updated_at: new Date() } }

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
    const base = getLayoutKey([root, joining], "root", [elsewhere])

    expect(getLayoutKey([root, { ...joining, joined_tasks: ["elsewhere", "more"] }], "root", [elsewhere])).not.toBe(
      base,
    )
    expect(getLayoutKey([root, child], "root", [elsewhere])).not.toBe(base)
    expect(getLayoutKey([root, joining], "root")).not.toBe(base)
    expect(getLayoutKey([root, joining], "root", [{ ...elsewhere, state: TaskState.SUCCESS }])).toBe(base)
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
    const { nodes } = getFlowGraph([root], "root", undefined, [elsewhere])
    const finished = { ...elsewhere, state: TaskState.SUCCESS }

    const refreshed = refreshNodeData(nodes, [root], [finished])

    const node = refreshed.find((candidate) => candidate.id === "joined:elsewhere")
    expect(node?.data).toEqual({ taskId: "elsewhere", task: finished })
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
    const { nodes } = getFlowGraph([root, member], "root", undefined, [run])
    const finished = { ...run, state: TaskState.SUCCESS }

    const refreshed = refreshNodeData(nodes, [root, member], [finished])

    expect(refreshed.find((node) => node.type === "joinedTaskNode")?.data).toEqual({ taskId: "run-1", task: finished })
    expect(refreshed.find((node) => node.id === "joined:run-1")?.data).toBe(member)
  })
})

describe("getFlowGraph joined runs", () => {
  const root = createTask({ id: "root", joined_tasks: ["elsewhere", "missing"] })
  const child = createTask({ id: "child", parent_id: "root", joined_tasks: ["elsewhere", "root"] })
  const elsewhere = createTask({ id: "elsewhere", workflow_id: "other" })

  it("draws joined runs as dashed extra nodes outside the workflow tree", () => {
    const { nodes, edges } = getFlowGraph([root, child], "root", undefined, [elsewhere])

    const joinedNodes = nodes.filter((node) => node.type === "joinedTaskNode")
    expect(joinedNodes.map((node) => node.id)).toEqual(["joined:elsewhere", "joined:missing"])
    expect(joinedNodes[0].data).toEqual({ taskId: "elsewhere", task: elsewhere })
    // A run that can't be loaded stays as a placeholder with only its id.
    expect(joinedNodes[1].data).toEqual({ taskId: "missing", task: undefined })
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

  it("keeps joined nodes off the rows of the tree", () => {
    const { nodes } = getFlowGraph([root, child], "root", undefined, [elsewhere])
    const treeRows = new Set(nodes.filter((node) => node.type === "taskNode").map((node) => node.position.y))

    for (const node of nodes.filter((candidate) => candidate.type === "joinedTaskNode"))
      expect(treeRows.has(node.position.y)).toBe(false)
  })

  it("bounds joined nodes and edges and draws the runs the read loads", () => {
    const runIds = Array.from({ length: 150 }, (_, index) => `run-${String(index).padStart(3, "0")}`)
    const fanOut = createTask({ id: "root", joined_tasks: [...runIds].reverse() })
    const children = Array.from({ length: 300 }, (_, index) =>
      createTask({ id: `child-${index}`, parent_id: "root", joined_tasks: ["run-000", "root"] }),
    )
    const tasks = [fanOut, ...children]

    const { nodes, edges, hiddenJoinedRuns } = getFlowGraph(tasks, "root")

    const joinedNodes = nodes.filter((node) => node.type === "joinedTaskNode")
    expect(joinedNodes.map((node) => (node.data as { taskId: string }).taskId).sort()).toEqual(joinedRunIds(tasks).ids)
    expect(joinedNodes).toHaveLength(MAX_JOINED_RUNS)
    expect(edges.filter((edge) => edge.style?.strokeDasharray)).toHaveLength(MAX_JOINED_RUNS)
    expect(hiddenJoinedRuns).toBe(50)
  })

  it("bounds dashed edges when many members join the same run", () => {
    const tasks = [
      createTask({ id: "root" }),
      ...Array.from({ length: 300 }, (_, index) =>
        createTask({ id: `child-${index}`, parent_id: "root", joined_tasks: ["shared"] }),
      ),
    ]

    const { nodes, edges, hiddenJoinedRuns, hiddenJoinLinks } = getFlowGraph(tasks, "root")

    expect(nodes.filter((node) => node.type === "joinedTaskNode")).toHaveLength(1)
    expect(edges.filter((edge) => edge.style?.strokeDasharray)).toHaveLength(MAX_JOINED_RUNS)
    expect(hiddenJoinedRuns).toBe(0)
    expect(hiddenJoinLinks).toBe(300 - MAX_JOINED_RUNS)
    expect(hiddenJoinsNote(hiddenJoinedRuns, hiddenJoinLinks)).toBe("200 join links not shown")
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

    const { nodes, edges } = getFlowGraph(tasks, "root")

    const ids = nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    const runNode = nodes.find((node) => node.type === "joinedTaskNode")
    expect(runNode?.data).toEqual({ taskId: "run-1", task: undefined })
    expect(ids).toContain("joined:joined:joined:run-1")
    const dashed = edges.filter((edge) => edge.style?.strokeDasharray).map((edge) => [edge.source, edge.target])
    expect(dashed).toEqual([
      ["root", runNode?.id],
      ["root", "joined:run-1"],
    ])
  })

  it("draws nothing extra without joins", () => {
    const { nodes, edges } = getFlowGraph([createTask({ id: "root" })], "root", undefined, [elsewhere])
    expect(nodes).toHaveLength(1)
    expect(edges).toHaveLength(0)
  })
})
