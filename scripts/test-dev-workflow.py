#!/usr/bin/env python3
"""Test workflow boundaries with fake tools; never build or install an actual app."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="finicky workflow ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "staged source"
        shutil.copytree(ROOT / "scripts", self.source / "scripts")
        shutil.copytree(ROOT / "apps/finicky/assets", self.source / "apps/finicky/assets")
        for folder in ("packages/config-api/dist", "packages/finicky-ui/dist", "apps/finicky/src/assets"):
            (self.source / folder).mkdir(parents=True)
        (self.source / "packages/config-api/dist/finickyConfigAPI.js").write_text("api")
        (self.source / "packages/config-api/dist/finicky.d.ts").write_text("types")
        (self.source / "packages/finicky-ui/dist/index.html").write_text("ui")
        tools = self.root / "tools"
        tools.mkdir()
        fake = tools / "fake.py"
        fake.write_text('''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["CALLS"], "a") as out:
    out.write(json.dumps([name] + args) + "\\n")
if any(a.startswith("/Applications") for a in args):
    sys.exit("forbidden application installation")
if name == "git":
    print("test123")
elif name == "go":
    if args == ["env", "GOHOSTARCH"]:
        print("arm64")
    else:
        target = pathlib.Path("apps/finicky/src") / args[args.index("-o")+1]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("executable")
elif name == "lipo":
    if "-output" in args:
        pathlib.Path(args[args.index("-output")+1]).write_text("universal executable")
elif name in ("cp", "rm", "rsync"):
    sys.exit(subprocess.call(["/bin/" + name if name != "rsync" else "/usr/bin/rsync"] + args))
''')
        fake.chmod(0o755)
        for name in ("npm", "go", "git", "lipo", "codesign", "cp", "rm", "rsync"):
            (tools / name).symlink_to(fake)
        self.calls = self.root / "calls.jsonl"
        self.env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"], CALLS=str(self.calls))
        for key in ("BUILD_TARGET_ARCH", "BUILD_UNIVERSAL", "FINICKY_DEV_WORKTREE"):
            self.env.pop(key, None)

    def build(self, *args, **env):
        subprocess.run([str(self.source / "scripts/build.sh"), *args], cwd=self.root,
                       env=dict(self.env, **env), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def plist(self, name):
        return plistlib.loads((self.source / "apps/finicky/build" / name / "Contents/Info.plist").read_bytes())

    def test_dev_stable_identity_override_and_schemes(self):
        original = self.root / "original checkout"
        original.mkdir()
        self.build("--dev", "--no-install", FINICKY_DEV_WORKTREE=str(original))
        first = self.plist("Finicky-Dev.app")
        expected = hashlib.sha256((str(original.resolve()) + "\n").encode()).hexdigest()[:12]
        self.assertEqual(first["CFBundleIdentifier"], "se.johnste.finicky.dev." + expected)
        self.assertTrue(first["FinickyDevelopment"])
        self.assertEqual(first["FinickyDevelopmentWorktree"], str(original.resolve()))
        self.assertEqual(first["CFBundleURLTypes"][0]["CFBundleURLSchemes"], ["http", "https", "finicky"])
        self.build("--dev", FINICKY_DEV_WORKTREE=str(original))
        self.assertEqual(first, self.plist("Finicky-Dev.app"))
        self.build("--dev")
        self.assertNotEqual(first["CFBundleIdentifier"], self.plist("Finicky-Dev.app")["CFBundleIdentifier"])

    def test_production_build_only_and_ci_outputs(self):
        self.build("--no-install")
        self.assertEqual(self.plist("Finicky.app")["CFBundleIdentifier"], "se.johnste.finicky")
        self.assertNotIn("FinickyDevelopment", self.plist("Finicky.app"))
        self.build(BUILD_UNIVERSAL="1")
        self.assertEqual(self.plist("Finicky.app")["CFBundleIdentifier"], "se.johnste.finicky")
        self.build(BUILD_TARGET_ARCH="amd64")
        self.assertEqual(self.plist("Finicky-amd64.app")["CFBundleIdentifier"], "se.johnste.finicky")

    def test_reject_dev_ci_combination_before_build(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.build("--dev", BUILD_UNIVERSAL="1")
        self.assertFalse(self.calls.exists())

    def test_scenario_headless_and_extra_flags(self):
        binary = self.source / "apps/finicky/build/Finicky-Dev.app/Contents/MacOS/Finicky"
        binary.parent.mkdir(parents=True)
        binary.write_text('#!/usr/bin/env python3\nimport json, os, sys\nopen(os.environ["ARGS"], "w").write(json.dumps(sys.argv[1:]))\n')
        binary.chmod(0o755)
        argsfile = self.root / "args.json"
        env = dict(self.env, ARGS=str(argsfile))
        script = str(self.source / "scripts/dev.sh")
        subprocess.run([script, "--headless", "both", "--dry-run"], cwd=self.root, env=env, check=True, stdout=subprocess.PIPE)
        args = json.loads(argsfile.read_text())
        self.assertNotIn("--window", args)
        self.assertIn("--dry-run", args)
        self.assertEqual(args[args.index("--config")+1], str(self.source / "testdata/config.js"))
        subprocess.run([script, "normal"], cwd=self.root, env=env, check=True, stdout=subprocess.PIPE)
        self.assertEqual(json.loads(argsfile.read_text()), ["--window"])
        subprocess.run([str(self.source / "scripts/dev-handlers.sh"), "status"], env=env, check=True)
        self.assertEqual(json.loads(argsfile.read_text()), ["--url-handlers", "status", "--handler-state", str(self.source / "apps/finicky/build/url-handlers.json")])


if __name__ == "__main__":
    unittest.main()
