"""Compare the built C# planner's report with the existing Python planner.

Run Build-And-Verify.ps1 first, then python mastercam/verify_parity.py.
This reads reference inputs only; it never rewrites the reference outputs.
"""
from __future__ import annotations

import base64
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
REPOSITORY = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPOSITORY / "tools"))
import sync_plan  # noqa: E402


def main() -> int:
    verifier = REPOSITORY / "mastercam" / "bin" / "VerifyPlanner.exe"
    if not verifier.is_file():
        print("Build the C# verifier with mastercam/Build-And-Verify.ps1 first.", file=sys.stderr)
        return 1
    run = subprocess.run(
        [str(verifier), str(REPOSITORY), "--parity"],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if run.returncode:
        print(run.stdout, end="")
        print(run.stderr, end="", file=sys.stderr)
        return run.returncode

    actual = {}
    for line in run.stdout.splitlines():
        if line.startswith("PARITY|"):
            _, case, encoded = line.split("|", 2)
            actual[case] = base64.b64decode(encoded).decode("utf-8")

    cases = sorted((REPOSITORY / "tools" / "conformance" / "cases").glob("*/ops.txt"))
    failures = []
    for source in cases:
        name = source.parent.name
        h_ops, v_ops, errors = sync_plan.parse_ops(source.read_text(encoding="utf-8"))
        if errors:
            failures.append(f"{name}: Python rejected the input: {errors}")
            continue
        stretches = sync_plan.h_stretches(h_ops)
        groups, cycle = sync_plan.plan_v(stretches, v_ops)
        expected = sync_plan.render(stretches, groups, cycle)
        if actual.get(name) != expected:
            failures.append(f"{name}: C# marked operation list differs from Python")
        else:
            print(f"PASS {name}: identical marker list and cycle summary")
    if set(actual) != {source.parent.name for source in cases}:
        failures.append("The C# verifier did not return exactly the reference case set.")
    if failures:
        for message in failures:
            print("FAIL " + message, file=sys.stderr)
        return 1
    print(f"C# / Python parity: {len(cases)} of {len(cases)} cases passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
