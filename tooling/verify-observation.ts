import { ObservationRpc } from "../runtime/observation/rpc"
import { initializeAuthentication } from "../runtime/security/http"
/** Native Bun application API acceptance against a disposable observation database. */
import { scopedDatabase, intersectScopes } from "../runtime/security/read-scope"
import { SearchIndexes } from "../runtime/search-indexes"
import { buildRead, operations } from "../runtime/observation/queries"
import { joinedRunsQuery, MAX_EXPANDED_TASKS, MAX_EXPANSION_DEPTH, MAX_JOINED_RUNS } from "../src/lib/joined-runs"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { randomBytes } from "node:crypto"
import { ObservationApi } from "../runtime/observation-api"
import { validateConfig } from "../runtime/config"
import { CORE_SCHEMA } from "../runtime/surreal-schema"
import { Surreal, Table } from "surrealdb"
const binary = process.env.SURREAL_BINARY ?? "surreal"
const version = Bun.spawnSync([binary, "version"])
if (version.exitCode !== 0 || !Buffer.from(version.stdout).toString().includes("3.3.0")) {
  if (process.env.CI) throw new Error("Application acceptance requires pinned SurrealDB 3.3.0\n")
  process.stdout.write("Database acceptance requires SurrealDB 3.3.0\n")
  process.exit(0)
}
const listener = createServer()
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
const address = listener.address()
assert(address && typeof address !== "string")
const port = address.port
await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
const rootPassword = randomBytes(24).toString("base64url")
const child = Bun.spawn([binary, "start", "--bind", `127.0.0.1:${port}`, "memory"], {
  stdout: "ignore",
  stderr: "inherit",
  env: { PATH: process.env.PATH, SURREAL_USER: "root", SURREAL_PASS: rootPassword },
})
const url = `http://127.0.0.1:${port}`
const root = new Surreal()
try {
  let ready = false
  const startupDeadline = Date.now() + 30_000
  while (Date.now() < startupDeadline) {
    assert(child.exitCode === null, `Disposable database exited with code ${child.exitCode}`)
    try {
      if ((await fetch(url + "/health", { signal: AbortSignal.timeout(1000) })).ok) {
        ready = true
        break
      }
    } catch {
      /* Fixture not listening yet. */
    }
    await Bun.sleep(50)
  }
  assert(ready, "Disposable database did not start")
  await root.connect(url)
  await root.signin({ username: "root", password: rootPassword })
  await root.query("DEFINE NAMESPACE test; USE NS test; DEFINE DATABASE observation;")
  await root.use({ namespace: "test", database: "observation" })
  await root.query(CORE_SCHEMA)
  await root.query(
    "CREATE task:sample SET type = 'sample', state = 'SUCCESS', execution_observed_at = time::now(), execution_active_at = time::now(), workflow_id = 'sample', runtime = 0.2, last_updated = time::now(), result = 'private-result', kwargs = '{\"channel\":\"north team\"}'; CREATE event:sample SET task_id = 'sample', event_type = 'task-succeeded', timestamp = time::now(); CREATE worker:sample SET status = 'online', last_updated = time::now(); CREATE workflow:sample SET root_task_id = 'sample', aggregate_state = 'SUCCESS', task_count = 1, last_updated = time::now(); RELATE workflow:sample->workflow_task:sample->task:sample;",
  )
  const api = new ObservationApi(root, validateConfig({}), async () => ({
    python_version: "fixture",
    ingestion: { events_ingested_total: 1, flushes_total: 1, buffer_size: 0, queue_size: 0 },
  }))
  assert.deepEqual(await api.counts(), { tasks: 1, events: 1, workers: 1 })
  for (const path of ["/metrics", "/metrics/verbose", "/metrics/system"]) {
    const response = await api.metrics(path)
    const content = await response.text()
    assert.match(
      content,
      path === "/metrics/system" ? /celery_insights_events_ingested_total 1/ : /celery_tasks_total 1/,
    )
    assert.match(
      content,
      path === "/metrics/system" ? /celery_insights_db_tasks_count 1/ : /celery_task_runtime_seconds_sum 0.2/,
    )
  }
  const csv = await api.exportCsv({
    kind: "explorer",
    mode: "tasks",
    from: "2000-01-01T00:00:00Z",
    to: "2100-01-01T00:00:00Z",
    sortField: "state; DELETE task;",
  })
  assert.match(await csv.text(), /private-result/)
  const indexes = new SearchIndexes(root)
  await indexes.start(true)
  // The Bun migration must preserve main's kwargs search in both export modes.
  for (const mode of ["tasks", "workflows"] as const) {
    for (const [query, matches] of [
      ['channel="north team"', true],
      ['channel="other"', false],
    ] as const) {
      const result = await api.exportCsv({
        kind: "explorer",
        mode,
        query,
        from: "2000-01-01T00:00:00Z",
        to: "2100-01-01T00:00:00Z",
      })
      assert.equal((await result.text()).includes('"sample"'), matches, `${mode} export: ${query}`)
    }
  }
  await root.query("UPDATE task:sample SET result = $result", { result: " \t=1+1" })
  const unsafeCsv = await api.exportCsv({
    kind: "explorer",
    mode: "tasks",
    from: "2000-01-01T00:00:00Z",
    to: "2100-01-01T00:00:00Z",
  })
  assert((await unsafeCsv.text()).includes("' \t=1+1"))
  await root.query("UPDATE task:sample SET result = 'private-result'")
  for (const table of ["task", "workflow"] as const) {
    const read = buildRead({
      operation: "explorer",
      table,
      query: 'channel="north team"',
      from: "2000-01-01T00:00:00Z",
      to: "2100-01-01T00:00:00Z",
    })
    const result = await root.query(read.sql, read.bindings).collect()
    // Tasks have six result sets; workflows have five, after any LET prelude.
    const matching = result.at(table === "task" ? -6 : -5) as unknown[]
    assert.equal(matching.length, 1, `${table} typed kwargs explorer`)
    const projection = scopedDatabase(root, { deny_fields: ["task.input.read"] })
    const denied = await projection.query(read.sql, read.bindings).collect()
    const deniedCsv = await api.withDatabase(projection).exportCsv({
      kind: "explorer",
      mode: table === "task" ? "tasks" : "workflows",
      query: 'channel="north team"',
      from: "2000-01-01T00:00:00Z",
      to: "2100-01-01T00:00:00Z",
    })
    assert.equal((await deniedCsv.text()).includes('"sample"'), false)

    assert.equal(
      (denied.at(table === "task" ? -6 : -5) as unknown[]).length,
      0,
      `${table} kwargs search cannot match denied inputs`,
    )
  }
  const noTasks = scopedDatabase(root, { task_ids: [], deny_fields: [] })
  const indexedRead = buildRead({
    operation: "explorer",
    query: 'channel="north team"',
    from: "2000-01-01T00:00:00Z",
    to: "2100-01-01T00:00:00Z",
  })
  const hiddenMatches = await noTasks.query(indexedRead.sql, indexedRead.bindings).collect()
  assert.deepEqual(hiddenMatches.slice(indexedRead.resultOffset)[0], [])
  const quickSearch = buildRead({ operation: "search", query: 'channel="north team"' })
  assert.equal(
    ((await root.query(quickSearch.sql, quickSearch.bindings).collect())[quickSearch.resultOffset] as unknown[]).length,
    1,
  )
  await indexes.stop()
  const backupResponse = await api.handle(
    new Request("http://localhost/api/settings/export"),
    "/api/settings/export",
    false,
  )
  const backup = await backupResponse!.json()
  for (const invalid of [null, [], { version: 2 }, { version: 1, credentials: { password: "unexpected" } }]) {
    assert.equal((await (await api.importBackup(invalid)).json()).success, false)
  }
  assert.equal(
    (
      await (
        await api.importBackup({ version: 1, tasks: [{ id: "unexpected_table:admin" }], events: [], workers: [] })
      ).json()
    ).success,
    false,
  )
  assert.deepEqual(await api.counts(), { tasks: 1, events: 1, workers: 1 })
  assert.equal((await (await api.importBackup(backup)).json()).success, true)
  assert.deepEqual(await api.counts(), { tasks: 1, events: 1, workers: 1 })
  const [restoredWorkflows, restoredEdges] = await root.query<[Array<{ task_count: number }>, unknown[]]>(
    "SELECT * FROM workflow; SELECT * FROM workflow_task;",
  )
  assert.equal(restoredWorkflows[0].task_count, 1)
  assert.equal(restoredEdges.length, 1)
  // Apply visibility before search, aggregation, export, and record lookups.
  await root.query(
    "CREATE task:hidden SET type = 'private.type', state = 'SUCCESS', workflow_id = 'hidden', parent_id = 'sample', args = 'hidden-args', result = 'hidden-result', exception = 'hidden-failure', last_updated = time::now(); CREATE event:hidden SET task_id = 'hidden', event_type = 'task-succeeded', timestamp = time::now();",
  )
  const scope = { task_ids: ["sample"], deny_fields: ["task.result.read" as const] }
  const scoped = scopedDatabase(root, scope)
  const [visible] = await scoped.query<[Array<Record<string, unknown>>]>("SELECT * FROM task")
  assert.equal(visible.length, 1)
  assert.equal(String(visible[0].id), "task:sample")
  for (const field of ["result", "parent_id", "root_id", "workflow_id"]) assert.equal(visible[0][field], undefined)
  assert.deepEqual(visible[0].children, [])
  assert.equal(visible[0].relationships_restricted, true)
  assert.ok(visible[0].execution_observed_at)
  assert.ok(visible[0].execution_active_at)
  const [unrestricted] = await scopedDatabase(root, { deny_fields: [] }).query<[Array<Record<string, unknown>>]>(
    "SELECT * FROM type::record('task', $taskId)",
    { taskId: "sample" },
  )
  assert.equal(unrestricted[0].relationships_restricted, undefined)
  const [payloadOnly] = await scopedDatabase(root, { deny_fields: ["task.result.read"] }).query<
    [Array<Record<string, unknown>>]
  >("SELECT * FROM type::record('task', $taskId)", { taskId: "sample" })
  assert.equal(payloadOnly[0].relationships_restricted, false)
  const [hidden] = await scoped.query<[unknown[]]>("SELECT * FROM type::record('task', $taskId)", { taskId: "hidden" })
  assert.deepEqual(hidden, [])
  // Point reads project the record itself; among many rows they must return exactly what a table scan would.
  await root.query(
    "FOR $i IN 0..40 { CREATE type::record('task', 'bulk_' + <string>$i) SET type = 'bulk', state = 'SUCCESS', workflow_id = 'bulk', result = 'bulk-result', args = 'bulk-args', last_updated = time::now(); CREATE type::record('event', 'bulk_' + <string>$i) SET task_id = 'bulk_' + <string>$i, event_type = 'task-succeeded', timestamp = time::now(); }",
  )
  const pointRead = async (db: Pick<Surreal, "query">, table: string, id: string) =>
    (await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM type::record('${table}', $id)`, { id }))[0]
  const payloadScope = scopedDatabase(root, { deny_fields: ["task.result.read"] })
  const [payloadRead] = await pointRead(payloadScope, "task", "bulk_7")
  assert.equal(String(payloadRead.id), "task:bulk_7")
  assert.equal(payloadRead.args, "bulk-args")
  assert.equal(payloadRead.result, undefined)
  assert.deepEqual(payloadRead.restricted_fields, ["task.result.read"])
  assert.equal(payloadRead.workflow_id, "bulk")
  assert.deepEqual(await pointRead(payloadScope, "task", "bulk_missing"), [])
  const rowScope = scopedDatabase(root, { task_ids: ["bulk_3"], deny_fields: ["task.input.read"] })
  const [rowRead] = await pointRead(rowScope, "task", "bulk_3")
  assert.equal(String(rowRead.id), "task:bulk_3")
  assert.equal(rowRead.result, "bulk-result")
  assert.equal(rowRead.args, undefined)
  assert.equal(rowRead.workflow_id, undefined)
  assert.deepEqual(await pointRead(rowScope, "task", "bulk_4"), [])
  assert.equal((await pointRead(rowScope, "event", "bulk_3")).length, 1)
  assert.deepEqual(await pointRead(rowScope, "event", "bulk_4"), [])
  await root.query("DELETE task WHERE type = 'bulk'; DELETE event WHERE string::starts_with(task_id, 'bulk_');")
  const [counts, events, workflows, search] = await scoped.query<[unknown[], unknown[], unknown[], unknown[]]>(
    "SELECT count() AS count FROM task GROUP ALL; SELECT * FROM event; SELECT * FROM workflow; SELECT * FROM task WHERE string::contains(result ?? '', 'private-result');",
  )
  assert.deepEqual(counts, [{ count: 1 }])
  assert.equal(events.length, 1)
  assert.deepEqual(workflows, [])
  assert.deepEqual(search, [])
  const view = api.withDatabase(scoped)
  assert.deepEqual(await view.counts(), { tasks: 1, events: 1, workers: 1 })
  const scopedBackup = await view.handle(
    new Request("http://localhost/api/settings/export"),
    "/api/settings/export",
    false,
  )
  assert.doesNotMatch(await scopedBackup!.text(), /hidden|private-result/)
  assert.doesNotMatch(
    await (
      await view.exportCsv({
        kind: "explorer",
        mode: "tasks",
        from: "2000-01-01T00:00:00Z",
        to: "2100-01-01T00:00:00Z",
      })
    ).text(),
    /hidden|private-result/,
  )
  const denyAll = scopedDatabase(root, intersectScopes(scope, { task_ids: [], deny_fields: [] }))
  assert.deepEqual((await denyAll.query("SELECT * FROM task"))[0], [])
  for (const operation of operations) {
    const read = buildRead({ operation, from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", taskId: "sample" })
    await scoped.query(read.sql, read.bindings)
  }
  // Joined runs belong to other workflows and are read through the same scoped projection as members.
  type WorkflowRead = {
    members: unknown[]
    expanded: Array<Record<string, unknown>>
    expansionCut: number
    joinedIds: string[]
    walkedIds: string[]
    joinedTotal: number
    membersCut: boolean
  }
  const workflowRead = buildRead({ operation: "task-workflow", taskId: "sample" })
  const readWorkflow = async (db: Pick<Surreal, "query">, read = workflowRead) =>
    (await db.query(read.sql, read.bindings).collect()).at(-1) as WorkflowRead
  const unjoined = await readWorkflow(root)
  assert.deepEqual([unjoined.joinedIds, unjoined.joinedTotal, unjoined.expanded], [[], 0, []], "no joins, no lookups")
  await root.query("UPDATE task:sample SET joined_tasks = ['hidden', 'ghost']")
  const joinedRuns = async (db: Pick<Surreal, "query">) => (await readWorkflow(db)).expanded
  const allJoined = await joinedRuns(root)
  assert.deepEqual(
    allJoined.map((task) => String(task.id)),
    ["task:hidden"],
    "unknown joined runs are omitted",
  )
  assert.equal(allJoined[0].state, "SUCCESS")
  const payloadJoined = await joinedRuns(scopedDatabase(root, { deny_fields: ["task.result.read"] }))
  assert.deepEqual(
    payloadJoined.map((task) => String(task.id)),
    ["task:hidden"],
  )
  assert.deepEqual(await joinedRuns(scoped), [], "task scopes hide joined runs like other relationships")
  assert.deepEqual((await readWorkflow(scoped)).joinedIds, [])
  const ghosted = await readWorkflow(root)
  assert.deepEqual(
    [ghosted.joinedIds, ghosted.joinedTotal],
    [["ghost", "hidden"], 2],
    "chosen ids keep unloadable runs",
  )
  // The read chooses the joined runs a view shows: the first ids in id order over every member, members left out.
  // 1,001 members put the oldest past the 1,000 the read returns. (The graph's 10,000-member view is covered in
  // flow-chart.test.ts: seeding 10,001 tasks that share an indexed workflow_id takes minutes in SurrealDB 3.3.0.)
  const bIds = Array.from({ length: MAX_JOINED_RUNS }, (_, index) => `b_${String(index).padStart(3, "0")}`)
  await root.query(
    "CREATE task:a_run SET state = 'SUCCESS', workflow_id = 'other', last_updated = time::now(); FOR $i IN 0..1001 { CREATE type::record('task', 'big_' + <string>(10000 + $i)) SET state = 'SUCCESS', workflow_id = 'big', last_updated = d'2020-01-01T00:00:00Z' + <duration>(<string>$i + 's'); }; UPDATE task:big_10000 SET joined_tasks = ['a_run', 'big_10500']; UPDATE task:big_11000 SET joined_tasks = $bIds;",
    { bIds },
  )
  const bigRead = buildRead({ operation: "task-workflow", taskId: "big_11000" })
  for (const db of [root, scopedDatabase(root, { deny_fields: ["task.result.read"] })]) {
    const big = await readWorkflow(db, bigRead)
    assert.equal(big.members.length, 1000)
    // The oldest member, beyond the members returned, still competes for the first ids.
    assert.deepEqual(big.joinedIds, ["a_run", ...bIds.slice(0, -1)])
    assert.equal(big.joinedTotal, MAX_JOINED_RUNS + 1)
    assert.equal(big.membersCut, false)
    assert.deepEqual(
      big.expanded.map((task) => String(task.id)),
      ["task:a_run"],
    )
  }
  // Past the member cap the read takes links from only some members, so the newest member (the first the graph holds)
  // can lose its joins; the read flags that. (10,001 members take minutes to seed, so this lowers the cap to 1,000.)
  const capped = joinedRunsQuery(1000)
  const cappedRead = (
    await root.query(`LET $workflowId = 'big';${capped.statements.join(";")};RETURN {${capped.fields}};`).collect()
  ).at(-1) as WorkflowRead
  assert.deepEqual(
    [cappedRead.joinedIds, cappedRead.membersCut],
    [["a_run"], true],
    "big_11000's joins fall outside the links read, and the read flags it",
  )
  await root.query("DELETE task WHERE workflow_id = 'big'; DELETE task:a_run;")
  // A joined run expands into its own subtree, by point reads along children and joined_tasks, never into the rest
  // of its workflow. Shapes from Fyr: the hierarchy task also lists finalize, whose parent is the resource task.
  await root.query(
    `FOR $i IN 0..300 { CREATE type::record('task', 'noise_' + <string>$i) SET state = 'SUCCESS', workflow_id = 'nightly', parent_id = 'nightly_root', last_updated = time::now(); };
    CREATE task:nightly_root SET state = 'SUCCESS', workflow_id = 'nightly', children = ['resource', 'noise_0', 'noise_1'], last_updated = time::now();
    CREATE task:resource SET type = 'cache_by_resource', state = 'STARTED', workflow_id = 'nightly', parent_id = 'nightly_root', root_id = 'nightly_root', children = ['hierarchy', 'finalize'], result = 'resource-result', last_updated = time::now();
    CREATE task:hierarchy SET type = 'cache_hierarchy', state = 'SUCCESS', workflow_id = 'nightly', parent_id = 'resource', children = ['finalize', 'metrics'], last_updated = time::now();
    CREATE task:finalize SET type = 'finalize_resource_run', state = 'SUCCESS', workflow_id = 'nightly', parent_id = 'resource', children = ['fail', 'resource'], last_updated = time::now();
    CREATE task:fail SET type = 'fail_resource_run', state = 'SUCCESS', workflow_id = 'nightly', parent_id = 'finalize', last_updated = time::now();
    CREATE task:metrics SET type = 'metric_family', state = 'SUCCESS', workflow_id = 'nightly', parent_id = 'hierarchy', joined_tasks = ['nested_run', 'sample'], last_updated = time::now();
    CREATE task:nested_run SET state = 'SUCCESS', workflow_id = 'nested', children = ['nested_child'], last_updated = time::now();
    CREATE task:nested_child SET state = 'SUCCESS', workflow_id = 'nested', parent_id = 'nested_run', last_updated = time::now();
    UPDATE task:sample SET joined_tasks = ['resource'];`,
  )
  const expandedIds = (read: WorkflowRead) => read.expanded.map((task) => String(task.id)).sort()
  const subtree = await readWorkflow(root)
  assert.deepEqual(subtree.joinedIds, ["resource"])
  assert.deepEqual(expandedIds(subtree), [
    "task:fail",
    "task:finalize",
    "task:hierarchy",
    "task:metrics",
    "task:nested_child",
    "task:nested_run",
    "task:resource",
  ])
  assert.equal(subtree.expansionCut, 0)
  // The walk reports every id it reached, including ones with no row yet, so a later row refreshes the view.
  await root.query("UPDATE task:fail SET children = ['fail_retry']")
  assert((await readWorkflow(root)).walkedIds.includes("fail_retry"))
  const restrictedSubtree = await readWorkflow(scopedDatabase(root, { deny_fields: ["task.result.read"] }))
  assert.deepEqual(expandedIds(restrictedSubtree), expandedIds(subtree))
  const rowScopedSubtree = await readWorkflow(
    scopedDatabase(root, { task_ids: ["sample", "resource"], deny_fields: [] }),
  )
  assert.deepEqual([rowScopedSubtree.joinedIds, rowScopedSubtree.expanded], [[], []])
  await root.query("DELETE task WHERE workflow_id IN ['nightly', 'nested']")
  // Expanded tasks carry only what their nodes need, never payloads: 200 tasks with 100 KiB results would
  // otherwise make a 20 MiB response, over the 16 MiB observation limit.
  await root.query(
    `CREATE task:heavy SET state = 'SUCCESS', workflow_id = 'heavy', children = $heavyChildren, result = $payload, last_updated = time::now();
    FOR $child IN $heavyChildren { CREATE type::record('task', $child) SET state = 'SUCCESS', workflow_id = $child, parent_id = 'heavy', result = $payload, args = $payload, last_updated = time::now(); };
    UPDATE task:sample SET joined_tasks = ['heavy'];`,
    {
      heavyChildren: Array.from({ length: 200 }, (_, index) => `heavy_${index}`),
      payload: "x".repeat(100 * 1024),
    },
  )
  const heavy = await readWorkflow(root)
  assert.equal(heavy.expanded.length, 201)
  for (const task of heavy.expanded)
    for (const field of ["result", "args", "kwargs", "exception", "traceback"])
      assert.equal(task[field], undefined, `${field} is not read for an expanded task`)
  assert(JSON.stringify(heavy).length < 1024 * 1024, "expanded runs stay far below the response limit")
  await root.query("DELETE task WHERE string::starts_with(workflow_id, 'heavy')")
  // Bounds: at most MAX_EXPANDED_TASKS reads, MAX_EXPANSION_DEPTH levels below the runs the workflow joined; the
  // rest counts as cut.
  // (The wide children get their own workflow ids: SurrealDB 3.3.0 inserts thousands of equal index values slowly.)
  await root.query(
    `CREATE task:wide SET state = 'STARTED', workflow_id = 'wide', children = $wideChildren, last_updated = time::now();
    FOR $i IN 0..${MAX_EXPANDED_TASKS + 100} { CREATE type::record('task', 'wide_' + <string>$i) SET state = 'SUCCESS', workflow_id = 'wide_' + <string>$i, last_updated = time::now(); };
    FOR $i IN 0..${MAX_EXPANSION_DEPTH + 2} { CREATE type::record('task', 'deep_' + <string>$i) SET state = 'SUCCESS', workflow_id = 'deep', children = ['deep_' + <string>($i + 1)], last_updated = time::now(); };
    UPDATE task:sample SET joined_tasks = ['wide'];`,
    { wideChildren: Array.from({ length: MAX_EXPANDED_TASKS + 100 }, (_, index) => `wide_${index}`) },
  )
  const wide = await readWorkflow(root)
  assert.equal(wide.expanded.length, MAX_EXPANDED_TASKS)
  assert.equal(wide.expansionCut, 101, "the root and the first wide children fit; the other 101 are cut")
  await root.query("UPDATE task:sample SET joined_tasks = ['deep_0']")
  const deep = await readWorkflow(root)
  assert.equal(deep.expanded.length, MAX_EXPANSION_DEPTH + 1, "the joined run and MAX_EXPANSION_DEPTH levels below it")
  assert.equal(deep.expansionCut, 1)
  await root.query("DELETE task WHERE workflow_id = 'deep' OR string::starts_with(workflow_id, 'wide')")
  await root.query("UPDATE task:sample SET joined_tasks = NONE")
  await root.query(
    "UPDATE task:sample SET args = 'private-input', kwargs = 'private-kwargs', exception = 'private-failure', traceback = 'private-traceback'; UPDATE worker:sample SET inspect = $inspect;",
    { inspect: JSON.stringify({ private: "private-worker" }) },
  )
  for (const [action, fields] of [
    ["task.input.read", ["args", "kwargs"]],
    ["task.result.read", ["result", "result_truncated"]],
    ["task.failure.read", ["exception", "traceback"]],
    ["worker.inspect.read", ["inspect"]],
  ] as const) {
    const projection = scopedDatabase(root, { deny_fields: [action] })
    const [records] = await projection.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM ${action === "worker.inspect.read" ? "worker" : "task"}`,
    )
    for (const record of records) for (const field of fields) assert.equal(record[field], undefined)
    const [matches] = await projection.query<[unknown[]]>(
      `SELECT * FROM ${action === "worker.inspect.read" ? "worker" : "task"} WHERE ${fields[0]} != NONE`,
    )
    assert.deepEqual(matches, [])
  }
  const selected = scopedDatabase(root, {
    task_types: ["sample"],
    task_workers: ["sample-worker"],
    worker_hostnames: ["sample"],
    deny_fields: [],
  })
  assert.deepEqual((await selected.query("SELECT * FROM task"))[0], [])
  assert.equal((await selected.query<[unknown[]]>("SELECT * FROM worker"))[0].length, 1)
  const injection = scopedDatabase(root, { task_ids: ["sample'); DELETE task; --"], deny_fields: [] })
  assert.deepEqual((await injection.query("SELECT * FROM task"))[0], [])
  assert.equal(
    (await root.query<[Array<{ count: number }>]>("SELECT count() AS count FROM task GROUP ALL"))[0][0].count,
    2,
  )
  const authentication = initializeAuthentication({
    public_origin: "http://localhost",
    accounts: [{ username: "test", password: "fixture", roles: ["administrator"] }],
  })
  const fixtureServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request, server: any) {
      if (server.upgrade(request, { data: {}, headers: { "sec-websocket-protocol": "cbor" } })) return
      return new Response(null, { status: 404 })
    },
    websocket: {
      open(socket: any) {
        socket.data.rpc = new ObservationRpc(
          socket,
          authentication,
          "test",
          root,
          { deny_fields: [] },
          false,
          false,
          100,
        )
      },
      message(socket: any, message: string | Uint8Array) {
        void socket.data.rpc!.receive(message)
      },
      close(socket: any) {
        socket.data.rpc?.stop()
      },
    },
  })
  const browser = new Surreal()
  try {
    await browser.connect(`ws://127.0.0.1:${fixtureServer.port}/api/observation/rpc`, { reconnect: false })
    const [tasks] = await browser.query<[unknown[]]>("observation:read", {
      request: { operation: "list", table: "task" },
    })
    assert.equal(tasks.length, 2)
    const [searchedTasks] = await browser.query<[unknown[]]>("observation:read", {
      request: { operation: "search", query: "private-kwargs" },
    })
    assert.equal(searchedTasks.length, 1, "SDK results omit internal index candidate slots")
    const live = await browser.live(new Table("task"))
    const refresh = await new Promise<unknown>((resolve) => live.subscribe((message) => resolve(message.value)))
    assert.deepEqual(refresh, { __observation_refresh: true })
    await live.kill()
    await assert.rejects(browser.query("SELECT * FROM task").collect())
  } finally {
    await browser.close()
    await fixtureServer.stop(true)
  }
  await root.query("DELETE task:hidden; DELETE event:hidden;")
  const update = new Request("http://localhost/api/settings/retention", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cleanup_interval_seconds: 60,
      task_max_count: 0,
      task_retention_hours: null,
      dead_worker_retention_hours: null,
    }),
  })
  await api.handle(update, "/api/settings/retention", false)
  await api.cleanup()
  assert.deepEqual(await api.counts(), { tasks: 0, events: 0, workers: 1 })
  process.stdout.write(
    "Bun acceptance passed: scoped reads/fields/exports, typed SDK/refreshes, metrics/backup/restore/cleanup\n",
  )
} finally {
  await root.close()
  child.kill()
  await child.exited
}
