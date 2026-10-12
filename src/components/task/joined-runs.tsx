import { Link } from "@tanstack/react-router"

/** Active runs a task joined instead of sending its own; most tasks never join one, so it renders nothing then. */
const JoinedRuns = ({ taskIds }: { taskIds?: string[] }) =>
  taskIds?.length ? (
    <div>
      <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Joined runs</p>
      <div className="flex flex-wrap gap-2">
        {taskIds.map((taskId) => (
          <Link
            key={taskId}
            to="/tasks/$taskId"
            params={{ taskId }}
            className="font-mono text-xs break-all text-primary underline hover:opacity-80"
          >
            {taskId}
          </Link>
        ))}
      </div>
    </div>
  ) : null

export default JoinedRuns
