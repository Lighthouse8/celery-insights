import { queryObservation, isObservationRefresh } from "@lib/observation-query"
import { useSurrealDB } from "@components/surrealdb-provider"
import { joinedRunsQuery } from "@lib/joined-runs"
import { extractId, type SurrealTask, type SurrealWorkflow } from "@/types/surreal-records"
import type { LiveSubscription, Uuid } from "surrealdb"
import { useCallback, useEffect, useRef, useState } from "react"

interface TaskWorkflowSnapshot {
  members: SurrealTask[]
  /** The joined runs the read chose and their expanded descendants (see JoinedRuns); never members. */
  expanded: SurrealTask[]
  /** The joined run ids the read chose, whether or not their records loaded. */
  joinedIds: string[]
  /** Every task id the read's walk reached, loaded or not: the chosen runs and what it expanded. */
  walkedIds: string[]
  /** Every joined run id the read checked, before the MAX_JOINED_RUNS cap. */
  joinedTotal: number
  /** Links out of the expanded tasks the read's bounds left unexpanded. */
  expansionCut: number
  /** The workflow has more members than the read took joins from (see JoinedRuns). */
  membersCut: boolean
  /** Joined ids past those the read checked for members aren't counted (see JoinedRuns). */
  joinsUnchecked: boolean
  task: SurrealTask | null
  workflow: SurrealWorkflow | null
}

interface UseTaskWorkflowResult extends TaskWorkflowSnapshot {
  error: Error | null
  isLoading: boolean
}

const joinedQuery = joinedRunsQuery()

// One observation refresh notifies every STARTED member at once; read the workflow once per burst.
const REFRESH_COALESCE_MS = 250
// A busy joined run from another workflow would otherwise re-read the whole view (and reset dragged nodes) 4x a second.
const EXPANDED_REFRESH_COALESCE_MS = 2000

const EMPTY_RESULT: TaskWorkflowSnapshot = {
  task: null,
  workflow: null,
  members: [],
  expanded: [],
  joinedIds: [],
  walkedIds: [],
  joinedTotal: 0,
  expansionCut: 0,
  membersCut: false,
  joinsUnchecked: false,
}

export function useTaskWorkflow(taskId: string): UseTaskWorkflowResult {
  const { db, status } = useSurrealDB()
  const [data, setData] = useState<TaskWorkflowSnapshot>(EMPTY_RESULT)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const subscriptionRef = useRef<LiveSubscription | null>(null)
  const workflowIdRef = useRef<string | null>(null)
  // Snapshot queries can resolve out of order; a response writes only when it is newer than the last one
  // written. Waiting for the newest request instead would drop every response while updates keep coming.
  const requestRef = useRef(0)
  const appliedRef = useRef(0)
  const joinedIdsRef = useRef<Set<string>>(new Set())

  const fetchSnapshot = useCallback(async () => {
    const request = ++requestRef.current
    if (!taskId) {
      appliedRef.current = request
      setData(EMPTY_RESULT)
      setIsLoading(false)
      return
    }

    try {
      const results = await queryObservation<
        Array<null | {
          members?: SurrealTask[]
          expanded?: SurrealTask[]
          joinedIds?: string[]
          walkedIds?: string[]
          joinedTotal?: number
          expansionCut?: number
          membersCut?: boolean
          joinsUnchecked?: boolean
          task?: SurrealTask | null
          workflow?: SurrealWorkflow | null
        }>
      >(
        db,
        { operation: "task-workflow", taskId },
        [
          "LET $task = (SELECT * FROM type::record('task', $taskId))[0]",
          "LET $workflowId = $task.workflow_id ?? $task.root_id ?? $taskId",
          "LET $members = SELECT * FROM task WHERE workflow_id = $workflowId ORDER BY last_updated DESC",
          ...joinedQuery.statements,
          `RETURN {task: $task, workflow: (SELECT * FROM type::record('workflow', $workflowId))[0], members: $members, ${joinedQuery.fields}};`,
        ].join(";"),
        { taskId },
      )
      if (request <= appliedRef.current) return
      appliedRef.current = request
      const result = results.at(-1)

      const next = {
        task: result?.task ?? null,
        workflow: result?.workflow ?? null,
        members: Array.isArray(result?.members) ? result.members : [],
        expanded: Array.isArray(result?.expanded) ? result.expanded : [],
        joinedIds: Array.isArray(result?.joinedIds) ? result.joinedIds : [],
        walkedIds: Array.isArray(result?.walkedIds) ? result.walkedIds : [],
        joinedTotal: result?.joinedTotal ?? 0,
        expansionCut: result?.expansionCut ?? 0,
        membersCut: result?.membersCut ?? false,
        joinsUnchecked: result?.joinsUnchecked ?? false,
      }
      workflowIdRef.current = next.task?.workflow_id || next.task?.root_id || next.task?.id?.toString() || taskId
      // Every id the walk reached, not only the records it found: a run or task with no row yet must refresh when it
      // gets one, and any expanded task's change refreshes too, as its node shows its state and progress.
      joinedIdsRef.current = new Set(next.walkedIds)
      setData(next)
      setError(null)
    } catch (err) {
      if (request <= appliedRef.current) return
      appliedRef.current = request
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      // Only the newest request ends loading; an older one may still finish after the task id changed.
      if (request === requestRef.current) setIsLoading(false)
    }
  }, [db, taskId])

  useEffect(() => {
    if (status !== "connected") return

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let refreshDue = 0
    // Keeps the earliest pending refresh: a workflow change doesn't wait out a joined-run change's longer window.
    const scheduleRefresh = (delay: number) => {
      const due = Date.now() + delay
      if (refreshTimer && refreshDue <= due) return
      clearTimeout(refreshTimer)
      refreshDue = due
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        void fetchSnapshot()
      }, delay)
    }

    const start = async () => {
      setIsLoading(true)
      await fetchSnapshot()
      if (cancelled) return

      const [liveId] = await db.query<[Uuid]>("LIVE SELECT * FROM task")
      const subscription = await db.liveOf(liveId)
      subscriptionRef.current = subscription
      unsubscribe = subscription.subscribe((message) => {
        if (isObservationRefresh(message.value)) {
          void fetchSnapshot()
          return
        }
        const record = message.value as unknown as SurrealTask
        const recordId = extractId(record.id)
        const workflowId = workflowIdRef.current
        const matchesWorkflow = !!workflowId && (record.workflow_id || record.root_id || recordId) === workflowId
        if (recordId === taskId || matchesWorkflow) scheduleRefresh(REFRESH_COALESCE_MS)
        else if (joinedIdsRef.current.has(recordId)) scheduleRefresh(EXPANDED_REFRESH_COALESCE_MS)
      })
    }

    start().catch((err) => {
      setError(err instanceof Error ? err : new Error(String(err)))
      setIsLoading(false)
    })

    return () => {
      cancelled = true
      // Responses still in flight belong to the previous task id or connection.
      appliedRef.current = requestRef.current
      clearTimeout(refreshTimer)
      unsubscribe?.()
      if (subscriptionRef.current) {
        subscriptionRef.current.kill().catch(() => {})
        subscriptionRef.current = null
      }
    }
  }, [db, fetchSnapshot, status, taskId])

  return { ...data, isLoading, error }
}
