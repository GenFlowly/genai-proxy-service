"""
A psycopg AsyncConnectionPool look-alike over stdlib sqlite3, for tests.

durable_runtime hands run_events and tool_ledger a psycopg pool configured with
autocommit and dict rows. This adapter gives the same surface —
`async with pool.connection() as conn`, `await conn.execute(sql, params)`,
`async with conn.transaction()`, cursors with async fetchone/fetchall and
rowcount — so the modules' real SQL runs unchanged in tests and in the durable
subprocess harness, with no Postgres. Translations are deliberately few:
`%s` placeholders, `DEFAULT now()`, psycopg Json parameters, JSONB/BOOLEAN
result columns, and unique violations raised as psycopg's UniqueViolation.
SQL that needs more than this is not portable and should not be added to
those modules.
"""
import contextlib
import json
import sqlite3

import psycopg.errors
from psycopg.types.json import Json

sqlite3.register_converter("JSONB", lambda raw: json.loads(raw))
sqlite3.register_converter("BOOLEAN", lambda raw: bool(int(raw)))
sqlite3.register_adapter(Json, lambda value: json.dumps(value.obj))


def _translate(sql: str) -> str:
    return sql.replace("%s", "?").replace("DEFAULT now()", "DEFAULT CURRENT_TIMESTAMP")


class _Cursor:
    def __init__(self, cursor: sqlite3.Cursor):
        self._cursor = cursor
        self.rowcount = cursor.rowcount

    async def fetchone(self):
        row = self._cursor.fetchone()
        return dict(row) if row is not None else None

    async def fetchall(self):
        return [dict(row) for row in self._cursor.fetchall()]


class _Connection:
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    async def execute(self, sql: str, params=()):
        try:
            return _Cursor(self._conn.execute(_translate(sql), tuple(params)))
        except sqlite3.IntegrityError as e:
            if "UNIQUE" in str(e) or "PRIMARY KEY" in str(e):
                raise psycopg.errors.UniqueViolation(str(e)) from e
            raise

    @contextlib.asynccontextmanager
    async def transaction(self):
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self._conn.execute("ROLLBACK")
            raise
        else:
            self._conn.execute("COMMIT")


class SqlitePool:
    """One sqlite3 connection per `connection()` block, autocommit, dict rows."""

    def __init__(self, path: str):
        self.path = path

    @contextlib.asynccontextmanager
    async def connection(self):
        conn = sqlite3.connect(
            self.path, isolation_level=None, timeout=30, detect_types=sqlite3.PARSE_DECLTYPES,
        )
        conn.row_factory = sqlite3.Row
        try:
            yield _Connection(conn)
        finally:
            conn.close()
