import { queryObservation, isObservationRefresh } from "@lib/observation-query"
import { useSurrealDB } from "@components/surrealdb-provider"
import { joinedRunIds, MAX_JOINED_RUNS } from "@lib/joined-runs"
import { extractId, type SurrealTask, type SurrealWorkflow } from "@/types/surreal-records"
import type { LiveSubscription, Uuid } from "surrealdb"
import { useCallback, useEffect, useRef, useState } from "react"

interface TaskWorkflowSnapshot {
  members: SurrealTask[]
  /** Runs the members joined; they belong to other workflows and are not members. */
  joined: SurrealTask[]
  task: SurrealTask | null
  workflow: SurrealWorkflow | null
}

interface UseTaskWorkflowResult extends TaskWorkflowSnapshot {
  error: Error | null
  isLoading: boolean
}

// One observation refresh notifies every STARTED member at once; read the workflow once per burst.
const REFRESH_COALESCE_MS = 250

const EMPTY_RESULT: TaskWorkflowSnapshot = {
  task: null,
  workflow: null,
  members: [],
  joined: [],
}

export function useTaskWorkflow(taskId: string): UseTaskWorkflowResult {
  const { db, status } = useSurrealDB()
  const [data, setData] = useState<TaskWorkflowSnapshot>(EMPTY_RESULT)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const subscriptionRef = useRef<LiveSubscription | null>(null)
  const workflowIdRef = useRef<string | null>(null)
  // Snapshot queries can resolve out of order; only the latest request may write.
  const requestRef = useRef(0)
  const joinedIdsRef = useRef<Set<string>>(new Set())

  const fetchSnapshot = useCallback(async () => {
    const request = ++requestRef.current
    if (!taskId) {
      setData(EMPTY_RESULT)
      setIsLoading(false)
      return
    }

    try {
      const results = await queryObservation<
        Array<null | {
          members?: SurrealTask[]
          joined?: SurrealTask[]
          task?: SurrealTask | null
          workflow?: SurrealWorkflow | null
        }>
      >(
        db,
        { operation: "task-workflow", taskId },
        `LET $task = (SELECT * FROM type::record('task', $taskId))[0];
                 LET $workflowId = $task.workflow_id ?? $task.root_id ?? $taskId;
                 LET $members = SELECT * FROM task WHERE workflow_id = $workflowId ORDER BY last_updated DESC;
                 LET $joinedCandidates = array::distinct(array::flatten(SELECT VALUE joined_tasks FROM task WHERE workflow_id = $workflowId AND joined_tasks != NONE));
                 LET $joinedIds = array::slice(array::sort(array::complement($joinedCandidates, SELECT VALUE record::id(id) FROM task WHERE workflow_id = $workflowId AND record::id(id) IN $joinedCandidates)), 0, ${MAX_JOINED_RUNS});
                 RETURN {
                    task: $task,
                    workflow: (SELECT * FROM type::record('workflow', $workflowId))[0],
                    members: $members,
                    joined: array::filter(array::map($joinedIds, |$id| (SELECT * FROM type::record('task', $id))[0]), |$joined| $joined != NONE)
                };`,
        { taskId },
      )
      if (request !== requestRef.current) return
      const result = results.at(-1)

      const next = {
        task: result?.task ?? null,
        workflow: result?.workflow ?? null,
        members: Array.isArray(result?.members) ? result.members : [],
        joined: Array.isArray(result?.joined) ? result.joined : [],
      }
      workflowIdRef.current = next.task?.workflow_id || next.task?.root_id || next.task?.id?.toString() || taskId
      // The ids the read asked for, not the records it found: a run that has no row yet must refresh when it gets one.
      joinedIdsRef.current = new Set(
        joinedRunIds(next.members.map((member) => ({ id: extractId(member.id), joined_tasks: member.joined_tasks })))
          .ids,
      )
      setData(next)
      setError(null)
    } catch (err) {
      if (request !== requestRef.current) return
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (request === requestRef.current) setIsLoading(false)
    }
  }, [db, taskId])

  useEffect(() => {
    if (status !== "connected") return

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined

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
        if ((recordId === taskId || matchesWorkflow || joinedIdsRef.current.has(recordId)) && !refreshTimer) {
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined
            void fetchSnapshot()
          }, REFRESH_COALESCE_MS)
        }
      })
    }

    start().catch((err) => {
      setError(err instanceof Error ? err : new Error(String(err)))
      setIsLoading(false)
    })

    return () => {
      cancelled = true
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
