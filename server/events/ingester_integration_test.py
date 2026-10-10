"""Exercise the ingestion queries on the same native engine used in production."""

import asyncio
import re
import shutil
import socket
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from pytest_mock import MockerFixture
from surrealdb import AsyncSurreal

from events.ingester import (
    SurrealDBIngester,
    build_task_upsert,
    build_workflow_membership_upsert,
    build_workflow_summary_recompute,
)
from surrealdb_client import SurrealConnection
from tasks.result_fetcher import _build_task_meta_upsert
from tasks.task_search import keyword_search_term


_schema_match = re.search(
    r"export const CORE_SCHEMA = `(.*?)`", (Path(__file__).parents[2] / "runtime/surreal-schema.ts").read_text(), re.S
)
assert _schema_match
CORE_SCHEMA = _schema_match[1]
requires_surreal = pytest.mark.skipif(shutil.which("surreal") is None, reason="SurrealDB 3.3+ CLI required")


@asynccontextmanager
async def surreal() -> AsyncIterator[SurrealConnection]:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    process = subprocess.Popen(
        ["surreal", "start", "--bind", f"127.0.0.1:{port}", "--user", "root", "--pass", "root", "memory"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        async with httpx.AsyncClient() as http:
            for _ in range(100):
                try:
                    if (await http.get(f"http://127.0.0.1:{port}/health")).is_success:
                        break
                except httpx.ConnectError:
                    pass
                await asyncio.sleep(0.1)
            else:
                pytest.fail("SurrealDB did not start")
        async with AsyncSurreal(f"ws://127.0.0.1:{port}/rpc") as db:
            await db.signin({"username": "root", "password": "root"})
            await db.use("integration", "ingestion")
            yield db
    finally:
        process.terminate()
        await asyncio.to_thread(process.wait, timeout=10)


async def rows(db: SurrealConnection, sql: str) -> list[dict]:
    result = await db.query(sql)
    assert isinstance(result, list)
    records = []
    for value in result:
        assert isinstance(value, dict)
        records.append(value)
    return records


@requires_surreal
@pytest.mark.asyncio
@pytest.mark.parametrize("poll_before_events", [False, True])
@pytest.mark.parametrize("search_indexing_enabled", [False, True])
async def test_batched_recovery_preserves_workflow_invocation_and_errors(
    *, poll_before_events: bool, search_indexing_enabled: bool
) -> None:
    async with surreal() as db:
        await db.query(
            "DEFINE TABLE task SCHEMALESS; DEFINE TABLE workflow SCHEMALESS; "
            "DEFINE TABLE workflow_task TYPE RELATION IN workflow OUT task"
        )
        if search_indexing_enabled:
            schema = Path(__file__).resolve().parents[2] / "runtime/search-index-schema.surql"
            await db.query(schema.read_text())
            await db.query("CREATE search_config:current SET enabled = true, ready = true")
        if poll_before_events:
            query, bindings = _build_task_meta_upsert(
                "child",
                {"status": "STARTED", "date_done": "2023-11-14T22:13:22.500Z"},
                search_indexing_enabled=search_indexing_enabled,
            )
            summary_query, summary_bindings = build_workflow_summary_recompute(
                {"uuid": "child", "timestamp": 1700000002.5}, 0
            )
            await db.query(f"{query};{summary_query}", bindings | summary_bindings)
            assert (await rows(db, "SELECT * FROM workflow:child"))[0]["task_count"] == 1
        events = [
            {"type": "task-sent", "uuid": "root", "timestamp": 1700000000.0, "name": "reports.generate"},
            {
                "type": "task-sent",
                "uuid": "child",
                "root_id": "root",
                "parent_id": "root",
                "timestamp": 1700000001.0,
                "name": "reports.render",
                "routing_key": "reports",
                "args": "('2023-11',)",
                "kwargs": "{'fmt': 'pdf'}",
                "retries": 1,
            },
            {"type": "task-retried", "uuid": "child", "timestamp": 1700000002.0, "exception": "TimeoutError()"},
            {"type": "task-succeeded", "uuid": "child", "timestamp": 1700000003.0},
            {"type": "task-received", "uuid": "child", "timestamp": 1700000001.5, "hostname": "worker-1"},
        ]
        queries = []
        params = {}
        for index, event in enumerate(events):
            for build in [build_task_upsert, build_workflow_membership_upsert, build_workflow_summary_recompute]:
                query, bindings = (
                    build(event, index, search_indexing_enabled=search_indexing_enabled)
                    if build is build_task_upsert
                    else build(event, index)
                )
                queries.append(query)
                params.update(bindings)
        await db.query("BEGIN TRANSACTION;" + ";".join(queries) + ";COMMIT TRANSACTION;", params)
        child = (await rows(db, "SELECT * FROM task:child"))[0]
        assert child["state"] == "SUCCESS"
        assert child["workflow_id"] == "root"
        assert child["root_id"] == "root"
        assert child["parent_id"] == "root"
        assert child["routing_key"] == "reports"
        invocation = {
            "type": "reports.render",
            "args": "('2023-11',)",
            "kwargs": "{'fmt': 'pdf'}",
            "retries": 1,
            "routing_key": "reports",
            "worker": "worker-1",
        }
        assert {field: child.get(field) for field in invocation} == invocation
        assert child["had_error"] is True
        assert child["first_observed_at"] == datetime.fromtimestamp(1700000001, tz=UTC)
        assert len(await rows(db, "SELECT * FROM workflow_task")) == 2
        assert (await rows(db, "SELECT * FROM workflow:root"))[0]["task_count"] == 2
        assert await rows(db, "SELECT * FROM workflow:child") == []
        assert child["kwargs_search_source"] == "saferepr"
        if search_indexing_enabled:
            projection = (await rows(db, "SELECT * FROM task_search:child"))[0]
            assert keyword_search_term("fmt=pdf") in projection["kwargs_terms"]
            assert projection["kwargs_fallback"] is False
            assert await rows(db, "SELECT * FROM workflow_search:child") == []

        query, bindings = _build_task_meta_upsert(
            "child",
            {"status": "SUCCESS", "date_done": "2023-11-14T22:13:24Z"},
            search_indexing_enabled=search_indexing_enabled,
        )
        await db.query(query, bindings)
        refreshed = (await rows(db, "SELECT * FROM task:child"))[0]
        assert refreshed["workflow_id"] == "root"
        assert refreshed["had_error"] is True
        assert refreshed["first_observed_at"] == child["first_observed_at"]
        assert refreshed["sent_at"] == child["sent_at"]
        assert {field: refreshed.get(field) for field in invocation} == invocation
        assert refreshed["kwargs_search_source"] == "saferepr"
        if search_indexing_enabled:
            assert (await rows(db, "SELECT * FROM task_search:child"))[0]["kwargs_terms"] == projection["kwargs_terms"]

        stale = {
            "type": "task-sent",
            "uuid": "child",
            "root_id": "stale-root",
            "parent_id": "stale-parent",
            "timestamp": 1700000000.5,
        }
        query, bindings = build_task_upsert(stale, 0, search_indexing_enabled=search_indexing_enabled)
        await db.query(query, bindings)
        after_stale = (await rows(db, "SELECT * FROM task:child"))[0]
        assert after_stale["root_id"] == "root"
        assert after_stale["workflow_id"] == "root"
        assert after_stale["parent_id"] == "root"
        assert after_stale["state"] == "SUCCESS"
        assert after_stale["last_updated"] == refreshed["last_updated"]
        assert len(await rows(db, "SELECT * FROM workflow:root")) == 1


@requires_surreal
@pytest.mark.asyncio
async def test_progress_follows_latest_report_and_resets_on_new_attempt(mocker: MockerFixture):
    async with surreal() as db:
        await db.query(CORE_SCHEMA)
        mocker.patch("events.ingester.get_db", return_value=db)
        ingester = SurrealDBIngester(asyncio.Queue())

        async def ingest(*events: dict) -> dict:
            ingester._buffer = list(events)
            await ingester._flush()
            assert ingester._buffer == [], "flush failed and re-queued the batch"
            return (await rows(db, "SELECT * FROM task:job"))[0]

        def progress(timestamp: float, **fields: object) -> dict:
            return {"type": "task-progress", "uuid": "job", "timestamp": timestamp, **fields}

        job = await ingest(
            {"type": "task-sent", "uuid": "job", "timestamp": 1700000000.0, "name": "reports.cache"},
            {"type": "task-started", "uuid": "job", "timestamp": 1700000001.0},
            progress(1700000003.0, current=4, total=10, description="Caching days"),
            progress(1700000002.0, current=2, total=10),
            progress(1700000004.0, current="x"),
            {"type": "task-progress", "uuid": "unknown", "timestamp": 1700000004.0, "current": 1},
        )
        assert job["state"] == "STARTED"
        assert job["progress"] == {
            "current": 4,
            "total": 10,
            "description": "Caching days",
            "updated_at": datetime.fromtimestamp(1700000003, tz=UTC),
        }
        assert await rows(db, "SELECT * FROM task:unknown") == []
        assert len(await rows(db, "SELECT * FROM event WHERE event_type = 'task-progress'")) == 4

        job = await ingest(
            {"type": "task-retried", "uuid": "job", "timestamp": 1700000005.0},
            {"type": "task-started", "uuid": "job", "timestamp": 1700000006.0},
        )
        assert job.get("progress") is None

        # A report from the first attempt that arrives after the retry started stays cleared.
        job = await ingest(progress(1700000005.5, current=9, total=10))
        assert job.get("progress") is None

        job = await ingest(progress(1700000007.0, current=1))
        assert job["progress"] == {"current": 1, "updated_at": datetime.fromtimestamp(1700000007, tz=UTC)}

        # The next attempt runs on a worker whose clock is behind the first one's. task-retried
        # still clears the first attempt's report, and the new attempt's own reports count.
        job = await ingest(
            progress(1700000020.0, current=7, total=10),
            {"type": "task-retried", "uuid": "job", "timestamp": 1700000021.0},
            {"type": "task-started", "uuid": "job", "timestamp": 1700000018.0},
        )
        assert job.get("progress") is None
        job = await ingest(progress(1700000019.0, current=1, total=10))
        assert job["progress"]["current"] == 1

        # With the attempt in each report, clocks no longer decide across workers: the next
        # attempt's worker runs behind, and a delayed report from the failed attempt, stamped
        # later than the new attempt's reports, is still ignored.
        job = await ingest(
            {"type": "task-received", "uuid": "job", "timestamp": 1700000030.0, "retries": 2},
            progress(1700000025.0, current=1, total=10, attempt=2),
            progress(1700000032.0, current=9, total=10, attempt=1),
        )
        assert job["progress"]["current"] == 1
        assert job["progress"]["attempt"] == 2
        job = await ingest(progress(1700000026.0, current=2, total=10, attempt=2))
        assert job["progress"]["current"] == 2
        # Once the task reports its attempt, an untagged report never replaces it, newer or not.
        job = await ingest(progress(1700000099.0, current=7, total=10))
        assert job["progress"]["current"] == 2

        # The next retry's task-received comes from a worker whose clock is behind: it still
        # raises retries, so a late report from attempt 2 is ignored even with no attempt 3 report.
        job = await ingest(
            {"type": "task-retried", "uuid": "job", "timestamp": 1700000040.0},
            {"type": "task-received", "uuid": "job", "timestamp": 1700000035.0, "retries": 3},
        )
        assert job["retries"] == 3
        # The result-backend poller then reads the failed attempt's metadata: it can't lower retries.
        query, bindings = _build_task_meta_upsert(
            "job", {"status": "RETRY", "retries": 0, "date_done": "2023-11-14T22:14:00Z"}
        )
        await db.query(query, bindings)
        assert (await rows(db, "SELECT * FROM task:job"))[0]["retries"] == 3
        job = await ingest(progress(1700000041.0, current=8, total=10, attempt=2))
        assert job["progress"]["attempt"] == 2
        assert job["progress"]["current"] == 2
