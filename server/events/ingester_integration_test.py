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
async def test_batched_recovery_preserves_workflow_invocation_and_errors():
    async with surreal() as db:
        await db.query(
            "DEFINE TABLE task SCHEMALESS; DEFINE TABLE workflow SCHEMALESS; "
            "DEFINE TABLE workflow_task TYPE RELATION IN workflow OUT task"
        )
        events = [
            {"type": "task-sent", "uuid": "root", "timestamp": 1700000000.0, "name": "reports.generate"},
            {
                "type": "task-sent",
                "uuid": "child",
                "root_id": "root",
                "timestamp": 1700000001.0,
                "name": "reports.render",
            },
            {"type": "task-retried", "uuid": "child", "timestamp": 1700000002.0, "exception": "TimeoutError()"},
            {"type": "task-succeeded", "uuid": "child", "timestamp": 1700000003.0},
            {"type": "task-received", "uuid": "child", "timestamp": 1700000001.5},
        ]
        queries = []
        params = {}
        for index, event in enumerate(events):
            for build in [build_task_upsert, build_workflow_membership_upsert, build_workflow_summary_recompute]:
                query, bindings = build(event, index)
                queries.append(query)
                params.update(bindings)
        await db.query("BEGIN TRANSACTION;" + ";".join(queries) + ";COMMIT TRANSACTION;", params)
        child = (await rows(db, "SELECT * FROM task:child"))[0]
        assert child["state"] == "SUCCESS"
        assert child["workflow_id"] == "root"
        assert child["type"] == "reports.render"
        assert child["had_error"] is True
        assert child["first_observed_at"] == datetime.fromtimestamp(1700000001, tz=UTC)
        assert len(await rows(db, "SELECT * FROM workflow_task")) == 2
        assert (await rows(db, "SELECT * FROM workflow:root"))[0]["task_count"] == 2

        query, bindings = _build_task_meta_upsert("child", {"status": "SUCCESS", "date_done": "2023-11-14T22:13:24Z"})
        await db.query(query, bindings)
        refreshed = (await rows(db, "SELECT * FROM task:child"))[0]
        assert refreshed["workflow_id"] == "root"
        assert refreshed["had_error"] is True
        assert refreshed["first_observed_at"] == child["first_observed_at"]
        assert refreshed["sent_at"] == child["sent_at"]


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
