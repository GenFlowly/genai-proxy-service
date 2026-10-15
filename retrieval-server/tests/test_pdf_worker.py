"""
Unit tests for the PDF render worker (plan 1.5; one-shot Typst children since
plan 5.2 removed the warm xhtml2pdf child).

Run with `python -m unittest tests.test_pdf_worker`.

These start real child processes (graph/pdf_render_child.py) and render with
Typst, so each test takes a fraction of a second to a few seconds.
"""
import asyncio
import io
import json
import os
import subprocess
import sys
import time
import unittest
from unittest import mock

from graph import heavy_slot, pdf_worker

_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_JOB = {"renderer": "typst", "markdown": "# Hi\n\n- a\n- b\n", "title": None}
# render_job fails on it inside the child: branding must be a dict.
_FAILING_OPTIONS = {"branding": "not a dict"}


def _big_table_job(rows: int) -> dict:
    lines = ["| " + " | ".join(f"column {c}" for c in range(6)) + " |", "|" + "---|" * 6]
    lines += ["| " + " | ".join(f"row {r} cell {c} text" for c in range(6)) + " |" for r in range(rows)]
    return {"renderer": "typst", "markdown": "\n".join(lines), "title": None}


def _creator(pdf: bytes) -> str:
    from pypdf import PdfReader

    return str(PdfReader(io.BytesIO(pdf)).metadata.get("/Creator"))


class _WorkerTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.worker = pdf_worker.PdfWorker()
        self.children = []
        spawn = self.worker._spawn

        async def recording_spawn(*args, **kwargs):
            child = await spawn(*args, **kwargs)
            self.children.append(child)
            return child

        self.worker._spawn = recording_spawn

    async def asyncTearDown(self):
        for child in self.children:
            await child.kill()

    def assertReaped(self, child):
        self.assertIsNotNone(child.proc.returncode)
        self.assertFalse(os.path.exists(child.tmpdir))


class PdfWorkerTests(_WorkerTestCase):
    async def test_renders_in_a_one_shot_child(self):
        out = await self.worker.render(dict(_JOB))
        self.assertEqual(out["status"], "ok")
        self.assertTrue(out["pdf"].startswith(b"%PDF"))
        self.assertTrue(_creator(out["pdf"]).startswith("Typst "))
        self.assertEqual(out["pages"], 1)
        self.assertEqual(out["renderer"], "typst")
        self.assertIn("queue_wait_seconds", out)
        self.assertIn("spawn_cpu_seconds", out)
        self.assertIn("render_cpu_seconds", out)
        self.assertGreater(out["child_peak_rss_bytes"], 0)
        self.assertNotIn("pdf_len", out)
        self.assertEqual([c.kind for c in self.children], ["typst"])
        self.assertReaped(self.children[0])

    async def test_every_render_gets_a_fresh_child(self):
        # Nothing is reused or recycled: a child serves one job, is reaped
        # with its temp dir, and the next job pays its own (small) spawn.
        first = await self.worker.render(dict(_JOB))
        second = await self.worker.render(dict(_JOB))
        self.assertEqual((first["status"], second["status"]), ("ok", "ok"))
        self.assertEqual(len(self.children), 2)
        self.assertNotEqual(self.children[0].proc.pid, self.children[1].proc.pid)
        for child in self.children:
            self.assertReaped(child)
        self.assertIn("spawn_cpu_seconds", second)

    async def test_a_job_pinned_to_the_removed_renderer_renders_with_typst(self):
        out = await self.worker.render({**_JOB, "renderer": "x2p_v1"})
        self.assertEqual((out["status"], out["renderer"]), ("ok", "typst"))
        self.assertTrue(_creator(out["pdf"]).startswith("Typst "))
        self.assertEqual([c.kind for c in self.children], ["typst"])

    async def test_a_failed_render_is_a_tool_error_and_its_child_is_reaped(self):
        out = await self.worker.render({**_JOB, "options": _FAILING_OPTIONS})
        self.assertEqual((out["status"], out["kind"]), ("error", "error"))
        self.assertNotIn("pdf", out)
        self.assertEqual(out["renderer"], "typst")
        self.assertReaped(self.children[0])
        # The next job starts a fresh child and renders.
        self.assertEqual((await self.worker.render(dict(_JOB)))["status"], "ok")
        self.assertEqual(len(self.children), 2)

    async def test_wall_clock_timeout_kills_and_reaps_the_child(self):
        # A 2,000-row table takes Typst about 3 s.
        with mock.patch.object(pdf_worker, "RENDER_TIMEOUT_SECONDS", 0.2):
            started = time.monotonic()
            out = await self.worker.render(_big_table_job(2000))
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["kind"], "timeout")
        self.assertLess(time.monotonic() - started, 2)
        self.assertReaped(self.children[0])
        # The next job starts a fresh child.
        self.assertEqual((await self.worker.render(dict(_JOB)))["status"], "ok")
        self.assertEqual(len(self.children), 2)

    @unittest.skipUnless(sys.platform.startswith("linux"), "RLIMIT_AS bounds are measured on Linux")
    async def test_running_out_of_memory_is_a_tool_error_not_a_crash(self):
        # Under a 200 MB address-space cap a small document still renders,
        # but a 2,000-row table (about 330 MB peak) aborts Typst's allocator.
        with mock.patch.object(pdf_worker, "TYPST_RLIMIT_MB", 200):
            small = await self.worker.render(dict(_JOB))
            out = await self.worker.render(_big_table_job(2000))
        self.assertEqual(small["status"], "ok")
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["kind"], "oom")
        self.assertEqual(len(self.children), 2)
        for child in self.children:
            self.assertReaped(child)

    async def test_busy_when_the_heavy_slot_stays_taken(self):
        self.assertTrue(heavy_slot.HEAVY_LOCK.acquire(timeout=5))
        try:
            with mock.patch.object(pdf_worker, "QUEUE_WAIT_SECONDS", 0.2):
                out = await self.worker.render(dict(_JOB))
                parsed, payload = await self.worker.parse("inspect_extract", b"%PDF-1.4")
        finally:
            heavy_slot.HEAVY_LOCK.release()
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["kind"], "busy")
        self.assertEqual(out["renderer"], "typst")
        self.assertGreaterEqual(out["queue_wait_seconds"], 0.2)
        self.assertEqual((parsed["status"], parsed["kind"], payload), ("error", "busy", b""))
        self.assertEqual(self.children, [])

    async def test_render_and_parse_each_leave_no_child_behind(self):
        out = await self.worker.render(dict(_JOB))
        header, payload = await self.worker.parse("inspect_extract", out["pdf"])
        self.assertEqual((header["status"], header["pages"]), ("ok", 1))
        self.assertIn("Hi", json.loads(payload.decode("utf-8"))[0])
        self.assertEqual([c.kind for c in self.children], ["typst", "parse"])
        for child in self.children:
            self.assertReaped(child)


class LogIsolationTests(_WorkerTestCase):
    """Plan 1.4: document text never reaches the server's logs or stderr."""

    async def test_rendered_text_never_reaches_the_parents_logs(self):
        import logging

        records = []

        class _Capture(logging.Handler):
            def emit(self, record):
                records.append(record)

        root = logging.getLogger()
        capture = _Capture(logging.DEBUG)
        level = root.level
        root.addHandler(capture)
        root.setLevel(logging.DEBUG)
        stderr = io.StringIO()
        try:
            with mock.patch("sys.stderr", stderr):
                # Ethiopic has no bundled font (a missing_glyph warning), the
                # image URL is refused (image_dropped), the TeX is unknown.
                ok = await self.worker.render({
                    **_JOB, "markdown": "Łukasz Wójcik 你好 ሰላም -> ✓ secret-payload-123 "
                                        "\\(\\secretcmd\\) ![x](https://example.com/secret-payload-123.png)",
                })
                failed = await self.worker.render({
                    **_JOB, "markdown": "secret-payload-123",
                    "options": {"branding": "secret-payload-123"},
                })
        finally:
            root.removeHandler(capture)
            root.setLevel(level)
        self.assertEqual(ok["status"], "ok")
        self.assertGreater(ok["warnings"].get("missing_glyph", 0), 0)
        self.assertNotIn("secret", json.dumps({k: v for k, v in ok.items() if k != "pdf"}))
        self.assertEqual(failed["status"], "error")
        for record in records:
            self.assertNotIn("secret-payload-123", record.getMessage())
            self.assertNotIn("secretcmd", record.getMessage())
        self.assertTrue(any("pdf render failed: status=error kind=error" in r.getMessage() for r in records))
        self.assertNotIn("secret-payload-123", stderr.getvalue())


class HeavySlotTests(unittest.IsolatedAsyncioTestCase):
    async def test_acquire_times_out_and_does_not_leak_the_lock(self):
        lock = heavy_slot.threading.Lock()
        self.assertTrue(await heavy_slot.acquire_async(lock, 1))
        self.assertFalse(await heavy_slot.acquire_async(lock, 0.1))
        lock.release()
        self.assertTrue(await heavy_slot.acquire_async(lock, 1))
        lock.release()

    async def test_cancelled_waiter_releases_a_late_acquisition(self):
        lock = heavy_slot.threading.Lock()
        lock.acquire()
        waiter = asyncio.create_task(heavy_slot.acquire_async(lock, 5))
        await asyncio.sleep(0.05)
        waiter.cancel()
        lock.release()  # the executor thread may now take it on the waiter's behalf
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        await asyncio.sleep(0.1)
        self.assertTrue(lock.acquire(timeout=2), "a cancelled waiter must not keep the slot")
        lock.release()


class ChildEnvironmentTests(unittest.TestCase):
    def test_child_env_carries_no_credentials(self):
        env = {
            "PATH": "/usr/bin", "LANG": "C.UTF-8", "AWS_SECRET_ACCESS_KEY": "x",
            "AWS_ACCESS_KEY_ID": "y", "DATABASE_URL": "postgres://u:p@h/db", "OPENAI_API_KEY": "k",
            "PYTHONPATH": "/evil", "PDF_TYPST_RLIMIT_MB": "600",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            child = pdf_worker._child_env("/tmp/pdf-child-x")
        for name in ("AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "DATABASE_URL", "OPENAI_API_KEY", "PYTHONPATH"):
            self.assertNotIn(name, child)
        self.assertEqual(child["TMPDIR"], "/tmp/pdf-child-x")
        self.assertEqual(child["HOME"], "/tmp/pdf-child-x")
        self.assertEqual(child["LC_ALL"], "C.UTF-8")
        self.assertEqual(child["MALLOC_ARENA_MAX"], "2")
        self.assertEqual(child["PDF_TYPST_RLIMIT_MB"], "600")

    def test_selftest_renders(self):
        proc = subprocess.run(
            [sys.executable, "-E", "-s", "-m", "graph.pdf_render_child", "--selftest"],
            cwd=_APP_DIR, capture_output=True, timeout=120,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stderr, b"")

    def test_a_child_that_gets_no_job_exits(self):
        from graph import pdf_render_child as child

        self.assertLessEqual(child.REQUEST_WAIT_SECONDS, 60)
        code = (
            "import sys\n"
            "from graph import pdf_render_child as c\n"
            "c.REQUEST_WAIT_SECONDS = 0.3\n"
            "sys.exit(c.main([sys.argv[1]]))\n"
        )
        proc = subprocess.Popen([sys.executable, "-E", "-s", "-c", code, json.dumps({"kind": "typst"})],
                                cwd=_APP_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
        try:
            self.assertEqual(proc.wait(timeout=30), 0)  # stdin stays open; nothing arrives
            self.assertEqual(proc.stdout.read(), b"")
        finally:
            proc.kill()
            proc.stdin.close()
            proc.stdout.close()

    @unittest.skipUnless(sys.platform.startswith("linux"), "seccomp is Linux-only")
    def test_sandboxed_child_cannot_open_sockets(self):
        code = (
            "import socket, sys\n"
            "from graph import pdf_render_child as c\n"
            "c._limit_self({'max_address_space': 0})\n"
            "try:\n"
            "    socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n"
            "except PermissionError:\n"
            "    sys.exit(0)\n"
            "sys.exit(3)\n"
        )
        proc = subprocess.run([sys.executable, "-E", "-s", "-c", code], cwd=_APP_DIR, timeout=60)
        self.assertEqual(proc.returncode, 0)

    def test_seccomp_program_builds_for_both_architectures(self):
        from graph import pdf_render_child as child

        for machine in ("x86_64", "aarch64"):
            program = child._seccomp_program(machine)
            self.assertEqual(program[-3:], [(0x06, 0, 0, 0x7FFF0000), (0x06, 0, 0, 0x00050001),
                                            (0x06, 0, 0, 0x80000000)])
            for code, jt, jf, _ in program:
                self.assertGreaterEqual(jt, 0)
                self.assertGreaterEqual(jf, 0)


if __name__ == "__main__":
    unittest.main()
