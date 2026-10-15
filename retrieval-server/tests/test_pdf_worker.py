"""
Unit tests for the PDF render worker (plan 1.5).

Run with `python -m unittest tests.test_pdf_worker`.

These start real child processes (graph/pdf_render_child.py) and render with
xhtml2pdf, so each test takes about a second.
"""
import asyncio
import os
import subprocess
import sys
import unittest
from unittest import mock

from graph import heavy_slot, pdf_worker

_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_JOB = {"renderer": "x2p_v1", "markdown": "# Hi\n\n- a\n- b\n", "title": None, "filename": "hi.pdf"}


def _big_table_job(rows: int) -> dict:
    lines = ["| " + " | ".join(f"column {c}" for c in range(6)) + " |", "|" + "---|" * 6]
    lines += ["| " + " | ".join(f"row {r} cell {c} text" for c in range(6)) + " |" for r in range(rows)]
    return {"renderer": "x2p_v1", "markdown": "\n".join(lines), "title": None, "filename": "big.pdf"}


class PdfWorkerTests(unittest.IsolatedAsyncioTestCase):
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
        await self.worker.close()
        for child in self.children:
            await child.kill()

    def assertReaped(self, child):
        self.assertIsNotNone(child.proc.returncode)
        self.assertFalse(os.path.exists(child.tmpdir))

    async def test_renders_in_a_warm_child_and_reuses_it(self):
        first = await self.worker.render(dict(_JOB))
        self.assertEqual(first["status"], "ok")
        self.assertTrue(first["pdf"].startswith(b"%PDF"))
        self.assertEqual(first["pages"], 1)
        self.assertEqual(first["renderer"], "x2p_v1")
        self.assertIn("queue_wait_seconds", first)
        self.assertIn("spawn_cpu_seconds", first)
        self.assertGreater(first["child_peak_rss_bytes"], 0)
        self.assertNotIn("pdf_len", first)

        second = await self.worker.render(dict(_JOB))
        self.assertEqual(second["status"], "ok")
        self.assertEqual(len(self.children), 1)
        self.assertNotIn("spawn_cpu_seconds", second)
        self.assertTrue(self.children[0].alive)

    async def test_recycles_after_the_configured_number_of_renders(self):
        with mock.patch.object(pdf_worker, "RECYCLE_RENDERS", 1):
            await self.worker.render(dict(_JOB))
            await self.worker.render(dict(_JOB))
        self.assertEqual(len(self.children), 2)
        self.assertReaped(self.children[0])

    async def test_a_failed_render_discards_the_warm_child(self):
        out = await self.worker.render({**_JOB, "title": 123})  # not a string: the render raises
        self.assertEqual((out["status"], out["kind"]), ("error", "error"))
        self.assertNotIn("pdf", out)
        self.assertIsNone(self.worker._warm)
        self.assertReaped(self.children[0])

    async def test_wall_clock_timeout_kills_and_reaps_the_child(self):
        with mock.patch.object(pdf_worker, "RENDER_TIMEOUT_SECONDS", 0.2):
            out = await self.worker.render(_big_table_job(400))
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["kind"], "timeout")
        self.assertIsNone(self.worker._warm)
        self.assertReaped(self.children[0])
        # The next job starts a fresh child.
        self.assertEqual((await self.worker.render(dict(_JOB)))["status"], "ok")
        self.assertEqual(len(self.children), 2)

    async def test_running_out_of_memory_is_a_tool_error_not_a_crash(self):
        with mock.patch.object(pdf_worker, "X2P_RLIMIT_MB", 140):
            out = await self.worker.render(_big_table_job(2000))
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["kind"], "oom")
        self.assertIsNone(self.worker._warm)

    async def test_busy_when_the_heavy_slot_stays_taken(self):
        self.assertTrue(heavy_slot.HEAVY_LOCK.acquire(timeout=5))
        try:
            with mock.patch.object(pdf_worker, "QUEUE_WAIT_SECONDS", 0.2):
                out = await self.worker.render(dict(_JOB))
        finally:
            heavy_slot.HEAVY_LOCK.release()
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["kind"], "busy")
        self.assertGreaterEqual(out["queue_wait_seconds"], 0.2)
        self.assertEqual(self.children, [])

    async def test_one_shot_renderers_get_a_fresh_child_per_job(self):
        out = await self.worker.render({**_JOB, "renderer": "typst"})
        # Typst may not be installed in every environment; either way the
        # child is gone afterwards.
        self.assertIn(out["status"], ("ok", "error"))
        self.assertEqual(len(self.children), 1)
        self.assertReaped(self.children[0])
        self.assertIsNone(self.worker._warm)


class LogIsolationTests(unittest.IsolatedAsyncioTestCase):
    """Plan 1.4: document text never reaches the server's logs or stderr."""

    async def test_rendered_text_never_reaches_the_parents_logs(self):
        import io
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
        worker = pdf_worker.PdfWorker()
        try:
            with mock.patch("sys.stderr", stderr):
                ok = await worker.render({**_JOB, "markdown": "Łukasz Wójcik 你好 -> ✓ secret-payload-123"})
                failed = await worker.render({**_JOB, "markdown": "secret-payload-123", "title": 123})
        finally:
            await worker.close()
            root.removeHandler(capture)
            root.setLevel(level)
        self.assertEqual(ok["status"], "ok")
        self.assertEqual(failed["status"], "error")
        for record in records:
            message = record.getMessage()
            self.assertNotIn("secret-payload-123", message)
            self.assertNotIn("<p>", message)
            self.assertFalse(record.name.startswith("xhtml2pdf"))
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
            "PYTHONPATH": "/evil", "PDF_RENDERER": "typst",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            child = pdf_worker._child_env("/tmp/pdf-child-x")
        for name in ("AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "DATABASE_URL", "OPENAI_API_KEY", "PYTHONPATH"):
            self.assertNotIn(name, child)
        self.assertEqual(child["TMPDIR"], "/tmp/pdf-child-x")
        self.assertEqual(child["HOME"], "/tmp/pdf-child-x")
        self.assertEqual(child["LC_ALL"], "C.UTF-8")
        self.assertEqual(child["PDF_RENDERER"], "typst")

    def test_selftest_renders(self):
        proc = subprocess.run(
            [sys.executable, "-E", "-s", "-m", "graph.pdf_render_child", "--selftest"],
            cwd=_APP_DIR, capture_output=True, timeout=120,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stderr, b"")

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
