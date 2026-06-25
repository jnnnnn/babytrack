#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.9"
# ///

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server"

def find_exe(name):
    """Resolve command, preferring .cmd on Windows."""
    exe = shutil.which(name)
    if exe is None and sys.platform == "win32":
        exe = shutil.which(name + ".cmd")
    return exe or name

def run(cmd, cwd=None, check=True):
    cmd = [find_exe(cmd[0])] + cmd[1:]
    print(f"  {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd or ROOT)
    if check and result.returncode != 0:
        sys.exit(result.returncode)
    return result

def uncovered():
    print("=== Uncovered Lines ===")
    run(["go", "test", "-coverprofile=coverage.out", "./..."], cwd=SERVER)
    coverage = SERVER / "coverage.out"
    if not coverage.exists():
        sys.exit(1)
    lines = coverage.read_text().splitlines()
    seen = set()
    for line in lines[1:]:  # skip mode line
        parts = line.split()
        if len(parts) < 3:
            continue
        count = parts[2]
        if count == "0":
            loc = parts[0]
            # "babytrackd/file.go:15.69,20.61" -> "file.go:15-20"
            path_range = loc.split(":", 1)
            filepath = Path(path_range[0]).name
            ranges = path_range[1].split(",")
            start = ranges[0].split(".")[0]
            end = ranges[1].split(".")[0] if len(ranges) > 1 else start
            if start == end:
                entry = f"server/{filepath}:{start}"
            else:
                entry = f"server/{filepath}:{start}-{end}"
            if entry not in seen:
                seen.add(entry)
                print(entry)
    for e in sorted(seen):
        pass  # already printed in order seen
    sys.exit(0)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--human", action="store_true")
    parser.add_argument("--uncovered", action="store_true")
    args = parser.parse_args()

    if args.uncovered:
        uncovered()

    # Format
    print("=== Format ===")
    run(["go", "fmt", "./..."], cwd=SERVER)

    # Lint
    print("=== Lint ===")
    static = SERVER / "static"
    js_files = list(static.glob("*.js"))
    html_files = list(static.glob("*.html"))
    lint_files = [str(f) for f in js_files + html_files]
    if lint_files:
        run(["npx", "eslint"] + lint_files)

    # Test
    print("=== Test ===")
    run(["go", "test", "-cover", "./..."], cwd=SERVER)

    # E2E
    print("=== E2E ===")
    db = SERVER / "babytrack.db"
    if db.exists():
        db.unlink()

    env = os.environ.copy()
    if args.human:
        print("(Human mode: headed browser, slowMo 1200ms)")
        env["HUMAN_MODE"] = "1"
        run(["npx", "playwright", "test", "--project=chromium"], env=env)
    else:
        run(["npx", "playwright", "test"])

    print("\nAll checks passed")

if __name__ == "__main__":
    main()
