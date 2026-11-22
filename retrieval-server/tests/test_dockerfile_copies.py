"""
The Dockerfile copies the server's modules by name, so a new local module that
nothing COPYs builds fine, passes these tests (they run from the source tree)
and then fails at import in production. That has happened three times
(http_metrics.py, run_cleanup.py, and the activity package, caught here).

Run with `python -m unittest tests.test_dockerfile_copies`.
"""
import ast
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
_COPY = re.compile(r"^COPY\s+(?!--from)(\S+)\s+\S+\s*$")


def _copied() -> set[str]:
    names = set()
    for line in (ROOT / "Dockerfile").read_text().splitlines():
        match = _COPY.match(line.strip())
        if match:
            names.add(match.group(1).rstrip("/"))
    return names


def _local_top_level() -> set[str]:
    names = {p.stem for p in ROOT.glob("*.py")}
    names |= {p.parent.name for p in ROOT.glob("*/__init__.py")}
    return names


def _imported_top_level(path: pathlib.Path) -> set[str]:
    tree = ast.parse(path.read_text(), filename=str(path))
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            out.add(node.module.split(".")[0])
    return out


class DockerfileCopiesTest(unittest.TestCase):
    def test_every_local_module_a_copied_file_imports_is_copied(self):
        copied = _copied()
        local = _local_top_level()
        shipped_files = []
        for name in copied:
            target = ROOT / name
            if target.is_dir():
                shipped_files += list(target.rglob("*.py"))
            elif target.suffix == ".py":
                shipped_files.append(target)
        self.assertTrue(shipped_files, "no COPY lines found")
        missing = {}
        for path in shipped_files:
            for module in _imported_top_level(path) & local:
                if module not in copied and f"{module}.py" not in copied:
                    missing.setdefault(module, []).append(str(path.relative_to(ROOT)))
        self.assertEqual(missing, {}, "imported by shipped code but not copied in the Dockerfile")


if __name__ == "__main__":
    unittest.main()
