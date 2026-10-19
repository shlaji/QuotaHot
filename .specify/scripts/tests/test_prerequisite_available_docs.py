import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from typing import cast, override


REPO_ROOT = Path(__file__).resolve().parents[3]
PYTHON_SCRIPT = REPO_ROOT / ".specify/scripts/python/check_prerequisites.py"
BASH_SCRIPT = REPO_ROOT / ".specify/scripts/bash/check-prerequisites.sh"
EXPECTED_DOCS = [
    "spec.md",
    "plan.md",
    "research.md",
    "data-model.md",
    "contracts/",
    "quickstart.md",
    "tasks.md",
]


class PrerequisiteAvailableDocsTests(unittest.TestCase):
    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    feature_dir: Path | None = None

    @override
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.feature_dir = Path(self.temp_dir.name) / "feature"
        self.feature_dir.mkdir()
        for name in ("spec.md", "plan.md", "research.md", "data-model.md", "quickstart.md", "tasks.md"):
            _ = (self.feature_dir / name).write_text(f"# {name}\n", encoding="utf-8")
        contracts = self.feature_dir / "contracts"
        contracts.mkdir()
        _ = (contracts / "api.md").write_text("contract\n", encoding="utf-8")

    @override
    def tearDown(self) -> None:
        assert self.temp_dir is not None
        self.temp_dir.cleanup()

    def test_python_json_reports_all_existing_required_and_optional_docs(self):
        result = self._run_json([sys.executable, os.fspath(PYTHON_SCRIPT)])

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["AVAILABLE_DOCS"], EXPECTED_DOCS)

    def test_bash_json_reports_all_docs_with_jq(self):
        if shutil.which("jq") is None:
            self.skipTest("jq is not installed")
        result = self._run_json(["bash", os.fspath(BASH_SCRIPT)])

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["AVAILABLE_DOCS"], EXPECTED_DOCS)

    def test_bash_json_reports_all_docs_without_jq(self):
        with tempfile.TemporaryDirectory() as bin_dir:
            for command in ("bash", "env", "dirname", "git", "python3", "grep", "head", "sed", "ls"):
                executable = shutil.which(command)
                if executable:
                    _ = os.symlink(executable, Path(bin_dir) / command)
            result = self._run_json(
                ["bash", os.fspath(BASH_SCRIPT)],
                extra_env={"PATH": bin_dir},
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["AVAILABLE_DOCS"], EXPECTED_DOCS)

    def test_text_output_reports_spec_plan_and_tasks(self):
        for command in (
            [sys.executable, os.fspath(PYTHON_SCRIPT)],
            ["bash", os.fspath(BASH_SCRIPT)],
        ):
            with self.subTest(command=command):
                result = self._run_json(command, json_mode=False)

                self.assertEqual(result.returncode, 0, result.stderr)
                for name in EXPECTED_DOCS:
                    self.assertIn(f"✓ {name}", result.stdout)

    def test_paths_only_skips_validation_and_keeps_path_json_shape(self):
        feature_dir = self._feature_dir()
        for name in ("spec.md", "plan.md", "tasks.md"):
            (feature_dir / name).unlink()
        for command in (
            [sys.executable, os.fspath(PYTHON_SCRIPT)],
            ["bash", os.fspath(BASH_SCRIPT)],
        ):
            with self.subTest(command=command):
                result = self._run_json(command, flags=["--paths-only", "--json"])

                self.assertEqual(result.returncode, 0, result.stderr)
                payload = cast(dict[str, object], json.loads(result.stdout))
                self.assertEqual(payload["FEATURE_DIR"], os.fspath(feature_dir))
                self.assertNotIn("AVAILABLE_DOCS", payload)

    def test_missing_required_spec_keeps_validation_error_and_exit_code(self):
        (self._feature_dir() / "spec.md").unlink()
        for command in (
            [sys.executable, os.fspath(PYTHON_SCRIPT)],
            ["bash", os.fspath(BASH_SCRIPT)],
        ):
            with self.subTest(command=command):
                result = self._run_json(
                    command,
                    flags=["--json", "--require-spec", "--require-tasks", "--include-tasks"],
                )

                self.assertEqual(result.returncode, 1)
                self.assertIn("spec.md not found", result.stderr)

    def test_template_content_remains_in_json_output(self):
        for command in (
            [sys.executable, os.fspath(PYTHON_SCRIPT)],
            ["bash", os.fspath(BASH_SCRIPT)],
        ):
            with self.subTest(command=command):
                result = self._run_json(
                    command,
                    flags=[
                        "--json",
                        "--require-spec",
                        "--require-tasks",
                        "--include-tasks",
                        "--template",
                        "tasks-template",
                    ],
                )

                self.assertEqual(result.returncode, 0, result.stderr)
                payload = cast(dict[str, object], json.loads(result.stdout))
                template_content = payload.get("TEMPLATE_CONTENT")
                if not isinstance(template_content, str):
                    self.fail("TEMPLATE_CONTENT must be a string")
                self.assertIn("# Tasks: [FEATURE NAME]", template_content)

    def _run_json(
        self,
        command: list[str],
        *,
        json_mode: bool = True,
        flags: list[str] | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "SPECIFY_INIT_DIR": os.fspath(REPO_ROOT),
                "SPECIFY_FEATURE_DIRECTORY": os.fspath(self._feature_dir()),
                "SPECIFY_FEATURE_NO_PERSIST": "1",
            }
        )
        if extra_env:
            env.update(extra_env)
        command_flags = (
            list(flags)
            if flags is not None
            else ["--require-spec", "--require-tasks", "--include-tasks"]
        )
        if json_mode and "--json" not in command_flags:
            command_flags.insert(0, "--json")
        return subprocess.run(
            [*command, *command_flags],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def _feature_dir(self) -> Path:
        assert self.feature_dir is not None
        return self.feature_dir


if __name__ == "__main__":
    _ = unittest.main()
