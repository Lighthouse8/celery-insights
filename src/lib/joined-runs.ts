import type { Task } from "@/types/surreal-records"

/** Joined runs one workflow view reads and draws; also the bound on the dashed edges the flowchart draws. */
export const MAX_JOINED_RUNS = 100

/**
 * The joined runs the task-workflow read chose for a workflow: `ids` (first MAX_JOINED_RUNS non-member ids in id
 * order, loadable or not), `total` (all of them, before the cap), and `tasks` (the records it could load).
 */
export interface JoinedRuns {
  ids: string[]
  total: number
  tasks: Task[]
}

export const NO_JOINED_RUNS: JoinedRuns = { ids: [], total: 0, tasks: [] }
