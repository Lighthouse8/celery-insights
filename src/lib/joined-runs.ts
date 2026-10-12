/** Joined runs one workflow view reads and draws; the task-workflow read and the flowchart share this bound. */
export const MAX_JOINED_RUNS = 100

/**
 * The runs `tasks` joined that aren't among `tasks`, in id order, capped at MAX_JOINED_RUNS. The task-workflow
 * read selects the same ids in SurrealQL, so the records it loads are the nodes the flowchart draws.
 */
export const joinedRunIds = (tasks: Array<{ id: string; joined_tasks?: string[] | null }>) => {
  const members = new Set(tasks.map((task) => task.id))
  const all = [...new Set(tasks.flatMap((task) => task.joined_tasks ?? []))].filter((id) => !members.has(id)).sort()
  return { ids: all.slice(0, MAX_JOINED_RUNS), total: all.length }
}
