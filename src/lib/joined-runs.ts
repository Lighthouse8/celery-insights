import type { Task } from "@/types/surreal-records"

/**
 * Joined runs one workflow view reads and draws; also the bound on the flowchart's dashed edges other than the one
 * entering each drawn run.
 */
export const MAX_JOINED_RUNS = 100
/** Tasks of joined runs (their roots and expanded descendants) one workflow view reads. */
export const MAX_EXPANDED_TASKS = 2000
/** Levels the read walks below the runs the workflow joined; runs joined further down share the count. */
export const MAX_EXPANSION_DEPTH = 20
/**
 * Members that joined runs whose joins the read considers. They are read through the joined_workflow_id index, so a
 * workflow's other members are never scanned. Past this, other joining members' joins aren't candidates; the read
 * reads one more to flag that (`membersCut`).
 */
export const MAX_LINKING_MEMBERS = 10000

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
  /** The read hit MAX_LINKING_MEMBERS: joins from members past those it read are missing. */
  membersCut?: boolean
}

export const NO_JOINED_RUNS: JoinedRuns = { ids: [], total: 0, tasks: [], walked: [], cut: 0 }

/**
 * What an expanded task's node and the walk need. Never payloads: up to MAX_EXPANDED_TASKS full records could
 * exceed the observation response limit.
 */
export const EXPANDED_TASK_FIELDS =
  "id,type,state,workflow_id,root_id,parent_id,children,joined_tasks,last_updated,execution_active,execution_observed_at,retries,progress"

// Never a member: the walk only reads tasks of other workflows.
const lookup = (ids: string) =>
  `array::filter(array::map(${ids},|$id| (SELECT ${EXPANDED_TASK_FIELDS} FROM type::record('task',$id) TIMEOUT 2s)[0]),|$found| $found != NONE AND $found.workflow_id != $workflowId)`
const idsOf = (records: string) => `array::map(${records},|$task| record::id($task.id))`
// Children recorded only by their parent_id (an imported run's children list can be empty), by the parent_id index:
// at most one more than the walk can still read.
const childrenOf = (level: number) =>
  `LET $byParent${level} = IF array::len($found${level - 1}) > 0 THEN (SELECT VALUE record::id(id) FROM task WHERE parent_id IN $parents${level} LIMIT math::max([0,${MAX_EXPANDED_TASKS} - array::len($seen${level - 1})]) + 1 TIMEOUT 2s) ELSE [] END`
// A task left out as a stale entry is read again if its own parent turns up later in the walk.
const linksOf = (level: number) =>
  `array::sort(array::distinct(array::concat(array::complement(array::filter(array::flatten(array::concat($found${level - 1}.children,$found${level - 1}.joined_tasks)),|$id| $id != NONE),array::concat($seen${level - 1},$skip)),array::complement($byParent${level},array::concat(array::complement($seen${level - 1},$stale${level - 1}),$skip)))))`
// A listed child whose parent_id names a task outside the expansion (so far) is a stale children entry: it isn't
// expanded, so its branch costs no reads. Joined runs keep their parent.
const notStale = (level: number) =>
  `|$task| ($task.parent_id ?? '') = '' OR $task.parent_id IN $expandedIds${level - 1} OR record::id($task.id) IN array::flatten($found${level - 1}.joined_tasks)`

/**
 * SurrealQL (after `$workflowId` is set) that chooses a workflow's joined runs and expands them: one indexed select
 * of the members that joined runs, then a breadth-first walk of `children`, `joined_tasks` and children by
 * `parent_id`, by point reads, never into members, at most MAX_EXPANDED_TASKS reads and MAX_EXPANSION_DEPTH levels.
 * `fields` are the result's joined-run fields.
 */
export const joinedRunsQuery = (linkingMembers = MAX_LINKING_MEMBERS): { statements: string[]; fields: string } => {
  const statements = [
    `LET $linkRows = SELECT record::id(id) AS task_id,joined_tasks FROM task WHERE joined_workflow_id = $workflowId LIMIT ${linkingMembers + 1} TIMEOUT 2s`,
    `LET $links = array::slice($linkRows,0,${linkingMembers})`,
    "LET $linked = array::sort(array::complement(array::distinct(array::filter(array::flatten($links.joined_tasks),|$id| $id != NONE)),$links.task_id))",
    // Members that joined nothing aren't in the links; a joined id is checked by point read instead.
    `LET $memberJoins = array::filter(array::slice($linked,0,${MAX_EXPANDED_TASKS}),|$id| (SELECT VALUE workflow_id FROM type::record('task',$id) TIMEOUT 2s)[0] = $workflowId)`,
    "LET $joinedCandidates = array::complement($linked,$memberJoins)",
    "LET $skip = array::concat($links.task_id,$memberJoins)",
    `LET $seen0 = array::slice($joinedCandidates,0,${MAX_JOINED_RUNS})`,
    `LET $found0 = ${lookup("$seen0")}`,
    `LET $expandedIds0 = ${idsOf("$found0")}`,
    "LET $stale0 = []",
  ]
  const cut: string[] = []
  // SurrealQL can't reassign a variable inside a loop, so each level is its own statements.
  for (let level = 1; level <= MAX_EXPANSION_DEPTH; level++) {
    const previous = level - 1
    statements.push(
      `LET $parents${level} = ${idsOf(`$found${previous}`)}`,
      childrenOf(level),
      `LET $next${level} = ${linksOf(level)}`,
      `LET $take${level} = array::slice($next${level},0,math::max([0,${MAX_EXPANDED_TASKS} - array::len($seen${previous})]))`,
      `LET $read${level} = ${lookup(`$take${level}`)}`,
      `LET $found${level} = array::filter($read${level},${notStale(level)})`,
      `LET $seen${level} = array::concat($seen${previous},$take${level})`,
      `LET $expandedIds${level} = array::concat($expandedIds${previous},${idsOf(`$found${level}`)})`,
      `LET $stale${level} = array::concat($stale${previous},array::complement(${idsOf(`$read${level}`)},$expandedIds${level}))`,
    )
    // Once the read budget runs out every later level takes nothing, so a cut id is never read later.
    cut.push(`array::complement($next${level},$take${level})`)
  }
  const last = MAX_EXPANSION_DEPTH
  const beyond = last + 1
  statements.push(
    `LET $parents${beyond} = ${idsOf(`$found${last}`)}`,
    childrenOf(beyond),
    `LET $beyond = ${linksOf(beyond)}`,
  )
  const found = Array.from({ length: last + 1 }, (_, level) => `$found${level}`).join(",")
  return {
    statements,
    fields: `joinedIds:$seen0,walkedIds:array::distinct($seen${last}),joinedTotal:array::len($joinedCandidates),expanded:array::concat(${found}),expansionCut:array::len(array::distinct(array::concat(${cut.join(",")},$beyond))),membersCut:array::len($linkRows) > ${linkingMembers}`,
  }
}
