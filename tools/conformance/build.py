"""
Reference cases: the exact outputs sync_insert.py gives for known inputs.

Each folder in cases/ has the inputs  ops.txt, H.nc, V.nc  and, in expected/,
what the Python produces with the settings listed at the top of report.txt:
    H_marked.nc, V_marked.nc   the marked programs (missing if there are errors)
    report.txt                 settings, timeline, errors and warnings

    python build.py           rewrite expected/ from the current Python
    python build.py --check   compare the current Python against expected/

A converted script is right when, with the same settings, it writes the same
H_marked.nc and V_marked.nc for every case (compare with  fc /b  on Windows)
and reports the same timeline numbers and the same errors and warnings by line.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import sync_insert as si  # noqa: E402
import sync_plan as sp  # noqa: E402

CASES = os.path.join(HERE, "cases")


def settings():
    names = [
        ("sync_plan", sp, ["SAFETY_SECONDS", "ROTATE_LOCKOUT_SECONDS", "TOOL_CHANGE_LOCKOUT_SECONDS",
                           "V_TOOL_CHANGE_SECONDS", "START_IS_B_EVENT"]),
        ("sync_insert", si, ["SKIP_VAR_BASE", "WORK_OFFSET_BASE", "B_CALC_CALL"]),
    ]
    return ["{}.{} = {}".format(module, name, getattr(obj, name)) for module, obj, keys in names for name in keys]


def run_case(folder):
    """Returns {file name: text} of everything the case should produce."""
    def read(name):
        with open(os.path.join(folder, name)) as f:
            return f.read()

    problems = si.Problems()
    h_marked, v_marked, timeline = si.mark(read("ops.txt"), read("H.nc").splitlines(), read("V.nc").splitlines(), problems)
    report = ["(settings)"] + settings() + [""]
    if h_marked is not None and not problems.errors:
        report += ["(timeline)"] + timeline + [""]
    report += ["(errors and warnings)"] + (problems.errors + problems.warnings or ["none"])
    out = {"report.txt": "\n".join(report) + "\n"}
    if h_marked is not None and not problems.errors:
        out["H_marked.nc"] = "\n".join(h_marked) + "\n"
        out["V_marked.nc"] = "\n".join(v_marked) + "\n"
    return out


def main(argv):
    check = "--check" in argv
    failures = 0
    for name in sorted(os.listdir(CASES)):
        folder = os.path.join(CASES, name)
        expected = os.path.join(folder, "expected")
        produced = run_case(folder)
        if not check:
            os.makedirs(expected, exist_ok=True)
            for old in os.listdir(expected):
                os.remove(os.path.join(expected, old))
            for file_name, text in produced.items():
                with open(os.path.join(expected, file_name), "w", newline="\n") as f:
                    f.write(text)
            print("wrote   " + name)
            continue
        on_disk = sorted(os.listdir(expected)) if os.path.isdir(expected) else []
        same = on_disk == sorted(produced)
        for file_name, text in produced.items():
            path = os.path.join(expected, file_name)
            if not os.path.exists(path):
                same = False
                continue
            with open(path, newline="") as f:
                if f.read() != text:
                    same = False
        print("{}  {}".format("ok    " if same else "CHANGED", name))
        failures += not same
    if check and failures:
        print("{} case(s) differ. If the change is intended, run build.py to update expected/.".format(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
