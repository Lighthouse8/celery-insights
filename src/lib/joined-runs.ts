import type { Task } from "@/types/surreal-records"

/** Joined runs one workflow view reads and draws; also the bound on the dashed edges the flowchart draws. */
export const MAX_JOINED_RUNS = 100
/** Tasks of joined runs (their roots and expanded descendants) one workflow view reads. */
export const MAX_EXPANDED_TASKS = 2000
/** Levels the read walks below the runs the workflow joined; runs joined further down share the count. */
export const MAX_EXPANSION_DEPTH = 20

/**
 * The joined runs the task-workflow read chose for a workflow: `ids` (first MAX_JOINED_RUNS non-member ids in id
 * order, loadable or not), `total` (all of them, before the cap), `tasks` (the records it loaded: those runs and
 * their expanded descendants, including runs those joined), `walked`, and `cut` (links it left unexpanded by its
 * bounds).
 */
export interface JoinedRuns {
  ids: string[]
  total: number
  tasks: Task[]
  /** Every id the read's walk reached: the chosen runs and every child or joined run it tried to read. */
  walked: string[]
  cut: number
}

export const NO_JOINED_RUNS: JoinedRuns = { ids: [], total: 0, tasks: [], walked: [], cut: 0 }

/**
 * What an expanded task's node and the walk need. Never payloads: up to MAX_EXPANDED_TASKS full records could
 * exceed the observation response limit.
 */
export const EXPANDED_TASK_FIELDS =
  "id,type,state,workflow_id,root_id,parent_id,children,joined_tasks,last_updated,execution_active,execution_observed_at"

const lookup = (ids: string) =>
  `array::filter(array::map(${ids},|$id| (SELECT ${EXPANDED_TASK_FIELDS} FROM type::record('task',$id) TIMEOUT 2s)[0]),|$found| $found != NONE)`
const linksOf = (records: string, seen: string) =>
  `array::sort(array::complement(array::distinct(array::filter(array::flatten(array::concat(${records}.children,${records}.joined_tasks)),|$id| $id != NONE)),array::concat(${seen},$links.task_id)))`

/**
 * SurrealQL (after `$workflowId` is set) that chooses a workflow's joined runs and expands them: one id-only select
 * over the members, then a breadth-first walk of `children` and `joined_tasks` by point reads, never into members,
 * at most MAX_EXPANDED_TASKS reads and MAX_EXPANSION_DEPTH levels. `fields` are the result's joined-run fields.
 */
export const joinedRunsQuery = (): { statements: string[]; fields: string } => {
  const statements = [
    "LET $links = SELECT record::id(id) AS task_id,joined_tasks FROM task WHERE workflow_id = $workflowId TIMEOUT 2s",
    "LET $joinedCandidates = array::sort(array::complement(array::distinct(array::filter(array::flatten($links.joined_tasks),|$id| $id != NONE)),$links.task_id))",
    `LET $seen0 = array::slice($joinedCandidates,0,${MAX_JOINED_RUNS})`,
    `LET $found0 = ${lookup("$seen0")}`,
  ]
  const cut: string[] = []
  // SurrealQL can't reassign a variable inside a loop, so each level is its own statements.
  for (let level = 1; level <= MAX_EXPANSION_DEPTH; level++) {
    const previous = level - 1
    statements.push(
      `LET $next${level} = ${linksOf(`$found${previous}`, `$seen${previous}`)}`,
      `LET $take${level} = array::slice($next${level},0,math::max([0,${MAX_EXPANDED_TASKS} - array::len($seen${previous})]))`,
      `LET $found${level} = ${lookup(`$take${level}`)}`,
      `LET $seen${level} = array::concat($seen${previous},$take${level})`,
    )
    // Once the read budget runs out every later level takes nothing, so a cut id is never read later.
    cut.push(`array::complement($next${level},$take${level})`)
  }
  const last = MAX_EXPANSION_DEPTH
  statements.push(`LET $beyond = ${linksOf(`$found${last}`, `$seen${last}`)}`)
  const found = Array.from({ length: last + 1 }, (_, level) => `$found${level}`).join(",")
  return {
    statements,
    fields: `joinedIds:$seen0,walkedIds:$seen${last},joinedTotal:array::len($joinedCandidates),expanded:array::concat(${found}),expansionCut:array::len(array::distinct(array::concat(${cut.join(",")},$beyond)))`,
  }
}
