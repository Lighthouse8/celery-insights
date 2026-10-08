import { useSurrealDB } from "@components/surrealdb-provider"
import { extractId, type SurrealTask, type SurrealTaskProgress, type SurrealWorkflow } from "@/types/surreal-records"
import type { LiveSubscription, Uuid } from "surrealdb"
import { useCallback, useEffect, useRef, useState } from "react"

interface TaskWorkflowSnapshot {
  members: SurrealTask[]
  task: SurrealTask | null
  workflow: SurrealWorkflow | null
}

interface UseTaskWorkflowResult extends TaskWorkflowSnapshot {
  error: Error | null
  isLoading: boolean
}

const EMPTY_RESULT: TaskWorkflowSnapshot = {
  task: null,
  workflow: null,
  members: [],
}

// Compares field by field, so key order and how the SDK serializes record ids
// and datetimes in a SELECT result versus a live payload can't hide a match.
const sameExceptProgress = (left: SurrealTask, right: SurrealTask): boolean => {
  const fields = new Set([...Object.keys(left), ...Object.keys(right)])
  fields.delete("progress")
  const value = (task: SurrealTask, field: string) => {
    const raw = (task as unknown as Record<string, unknown>)[field]
    return raw instanceof Date ? raw.toISOString() : JSON.stringify(raw ?? null)
  }
  return [...fields].every((field) => value(left, field) === value(right, field))
}

// Microseconds since the epoch. The ingester stores microsecond timestamps, and Date
// keeps only milliseconds, which would order two reports in the same millisecond wrongly.
const microsOf = (value: unknown): number => {
  if (!value) return Number.NEGATIVE_INFINITY
  const iso = value instanceof Date ? value.toISOString() : String(value)
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(iso)
  if (!match) return new Date(iso).getTime() * 1000
  const fraction = Number((match[2] ?? "").padEnd(6, "0").slice(0, 6))
  return Date.parse(`${match[1]}${match[3]}`) * 1000 + fraction
}

// The ingester's rules, applied to a report the page already knows against a fresh record.
const isNewerProgress = (known: SurrealTaskProgress, task: SurrealTask): boolean => {
  if (typeof known.attempt === "number") {
    // Attempts order reports regardless of worker clocks.
    if (known.attempt < (task.retries ?? 0)) return false
    const fresh = task.progress
    if (typeof fresh?.attempt === "number" && fresh.attempt !== known.attempt) return known.attempt > fresh.attempt
    return !fresh || microsOf(known.updated_at) > microsOf(fresh.updated_at)
  }
  const reportedAt = microsOf(known.updated_at)
  if (reportedAt < microsOf(task.last_started_at)) return false
  // An empty fresh report after a later state change (task-retried clears progress) stays empty.
  return task.progress ? reportedAt > microsOf(task.progress.updated_at) : reportedAt > microsOf(task.last_updated)
}

/**
 * Keep progress newer than a fresh snapshot's: a progress patch can land while
 * that snapshot's query is in flight, and nothing would bring it back.
 */
export function keepNewerProgress(next: TaskWorkflowSnapshot, known: TaskWorkflowSnapshot): TaskWorkflowSnapshot {
  const knownProgress = new Map<string, SurrealTask["progress"]>()
  for (const task of [known.task, ...known.members]) {
    if (task?.progress) knownProgress.set(extractId(task.id), task.progress)
  }
  const merge = (task: SurrealTask): SurrealTask => {
    const progress = knownProgress.get(extractId(task.id))
    return progress && isNewerProgress(progress, task) ? { ...task, progress } : task
  }
  return { ...next, task: next.task && merge(next.task), members: next.members.map(merge) }
}

/**
 * Patch a task whose only change is its progress into the snapshot; undefined
 * when anything else changed or the task isn't in it. Every progress report is a
 * live change, so re-querying the whole workflow for each one would cost a
 * snapshot query per report on every open page.
 */
export function applyProgressOnlyChange(
  snapshot: TaskWorkflowSnapshot,
  record: SurrealTask,
): TaskWorkflowSnapshot | undefined {
  const recordId = extractId(record.id)
  const isRecord = (task: SurrealTask | null) => !!task && extractId(task.id) === recordId
  const memberIndex = snapshot.members.findIndex(isRecord)
  const known = [snapshot.task, snapshot.members[memberIndex]].filter((task) => isRecord(task ?? null))
  if (!known.length || known.some((task) => !sameExceptProgress(task as SurrealTask, record))) {
    return undefined
  }
  return {
    ...snapshot,
    task: isRecord(snapshot.task) ? record : snapshot.task,
    members: snapshot.members.map((member, index) => (index === memberIndex ? record : member)),
  }
}

export function useTaskWorkflow(taskId: string): UseTaskWorkflowResult {
  const { db, status } = useSurrealDB()
  const [data, setData] = useState<TaskWorkflowSnapshot>(EMPTY_RESULT)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const subscriptionRef = useRef<LiveSubscription | null>(null)
  const workflowIdRef = useRef<string | null>(null)
  const snapshotRef = useRef<TaskWorkflowSnapshot>(EMPTY_RESULT)

  const fetchSnapshot = useCallback(async () => {
    if (!taskId) {
      setData(EMPTY_RESULT)
      setIsLoading(false)
      return
    }

    try {
      const results = await db.query<
        Array<null | {
          members?: SurrealTask[]
          task?: SurrealTask | null
          workflow?: SurrealWorkflow | null
        }>
      >(
        `LET $task = (SELECT * FROM type::record('task', $taskId))[0];
                 LET $workflowId = $task.workflow_id ?? $task.root_id ?? $taskId;
                 RETURN {
                    task: $task,
                    workflow: (SELECT * FROM type::record('workflow', $workflowId))[0],
                    members: SELECT * FROM task WHERE workflow_id = $workflowId ORDER BY last_updated DESC
                };`,
        { taskId },
      )
      const result = results.at(-1)

      const next = {
        task: result?.task ?? null,
        workflow: result?.workflow ?? null,
        members: Array.isArray(result?.members) ? result.members : [],
      }
      workflowIdRef.current = next.task?.workflow_id || next.task?.root_id || next.task?.id?.toString() || taskId
      const merged = keepNewerProgress(next, snapshotRef.current)
      snapshotRef.current = merged
      setData(merged)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [db, taskId])

  useEffect(() => {
    if (status !== "connected") return

    let cancelled = false
    let unsubscribe: (() => void) | undefined

    const start = async () => {
      setIsLoading(true)
      await fetchSnapshot()
      if (cancelled) return

      const [liveId] = await db.query<[Uuid]>("LIVE SELECT * FROM task")
      const subscription = await db.liveOf(liveId)
      subscriptionRef.current = subscription
      unsubscribe = subscription.subscribe((message) => {
        const record = message.value as unknown as SurrealTask
        const recordId = extractId(record.id)
        const workflowId = workflowIdRef.current
        const matchesWorkflow = !!workflowId && (record.workflow_id || record.root_id || recordId) === workflowId
        if (recordId === taskId || matchesWorkflow) {
          const patched = message.action === "UPDATE" ? applyProgressOnlyChange(snapshotRef.current, record) : undefined
          if (patched) {
            snapshotRef.current = patched
            setData(patched)
          } else {
            void fetchSnapshot()
          }
        }
      })
    }

    start().catch((err) => {
      setError(err instanceof Error ? err : new Error(String(err)))
      setIsLoading(false)
    })

    return () => {
      cancelled = true
      unsubscribe?.()
      if (subscriptionRef.current) {
        subscriptionRef.current.kill().catch(() => {})
        subscriptionRef.current = null
      }
    }
  }, [db, fetchSnapshot, status, taskId])

  return { ...data, isLoading, error }
}
