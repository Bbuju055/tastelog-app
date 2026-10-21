"""Offline regression checks for database-image acquisition (no Docker needed)."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class PrepareImageTests(unittest.TestCase):
    def run_prepare(self, cached=False, failures=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / "docker"
            docker.write_text('''#!/usr/bin/env bash
echo "$*" >> "$FAKE_ROOT/calls"
if [ "$1" = image ]; then exit "$INSPECT_EXIT"; fi
n=0
if [ -f "$FAKE_ROOT/count" ]; then n=$(cat "$FAKE_ROOT/count"); fi
n=$((n + 1))
echo "$n" > "$FAKE_ROOT/count"
[ "$n" -gt "$PULL_FAILURES" ]
''')
            docker.chmod(0o755)
            sleep = root / "sleep"
            sleep.write_text('#!/usr/bin/env bash\necho "sleep $*" >> "$FAKE_ROOT/calls"\n')
            sleep.chmod(0o755)
            env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}",
                       FAKE_ROOT=str(root), INSPECT_EXIT="0" if cached else "1",
                       PULL_FAILURES=str(failures))
            result = subprocess.run(
                ["bash", str(Path(__file__).with_name("prepare_image.sh"))],
                env=env, capture_output=True, text=True, check=False,
            )
            return result, (root / "calls").read_text().splitlines()

    def test_cached_image_needs_no_registry(self):
        result, calls = self.run_prepare(cached=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)

    def test_cold_pull_uses_only_declared_image(self):
        result, calls = self.run_prepare()
        image = Path(__file__).with_name("postgres-image.txt").read_text().strip()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls, [f"image inspect {image}", f"pull {image}"])

    def test_transient_failure_recovers(self):
        result, calls = self.run_prepare(failures=2)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(sum(line.startswith("pull ") for line in calls), 3)
        self.assertEqual([line for line in calls if line.startswith("sleep")],
                         ["sleep 15", "sleep 30"])

    def test_persistent_failure_is_fatal_and_bounded(self):
        result, calls = self.run_prepare(failures=99)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(line.startswith("pull ") for line in calls), 3)
        self.assertIn("database proof has NOT run", result.stderr)


if __name__ == "__main__":
    unittest.main()
