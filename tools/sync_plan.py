"""
Sync planner: reads a Mastercam operation list and marks where the two
spindles must wait for each other around B rotations.

Usage:   python sync_plan.py ops.txt
Writes:  ops_sync.txt next to the input (and prints the same text).

Input, one operation per line, in the order each spindle runs:
    FAM_2H 11001 := 00:04
    FAM_2V 21013 := 00:01
      _2H / _2V   spindle (H = horizontal, V = vertical)
      1 1 001     <offset><rotation><tool>
      00:04       backplot time, <minutes>:<seconds>, tool change included

Rules:
  - Only H moves the B. A "B event" happens when H changes tool or rotation:
      rotation only:  retract, B indexes, cut at the new position
      tool change:    retract, B to the safe spot, T, B back to cutting position
  - Nothing cuts while the B rotates, and the B cannot rotate until V has
    finished its current operation.
  - Between B events, V cuts alongside H (V follows the B with G68).
  - V's rotation digit only counts plane changes; it is ignored here.
  - Each spindle keeps its own operation order.

Output: the H operations, then the V operations, with marker lines:
    H:  (WAIT BEFORE) and (WAIT AFTER)   at each B rotation
    V:  (WAIT)                           at each B event
The Nth V (WAIT) pairs with the Nth H rotation. V gets a (WAIT) at every
B event, even when it has nothing to cut in that stretch, so the counts
always match.
"""
import os
import re
import sys

# ---- Settings ---------------------------------------------------------------
SAFETY_SECONDS = 6  # added to every backplot time
# Seconds from (WAIT BEFORE) to (WAIT AFTER) when V cannot cut. H's backplot
# time already includes this; V has to sit it out.
ROTATE_LOCKOUT_SECONDS = 4  # same tool: retract and one B index
TOOL_CHANGE_LOCKOUT_SECONDS = 10  # B to safe spot, T, B back to cutting position
# Seconds of each V tool change (already inside V's backplot time). V changes
# tools before its (WAIT), while H is still cutting or moving the B.
V_TOOL_CHANGE_SECONDS = 8
# True: the B moves at cycle start (counted as a tool change), so V waits for
# the first (WAIT AFTER). False: the B is already in position and V starts
# cutting right away.
START_IS_B_EVENT = True

# ---- 1. Parse ---------------------------------------------------------------
#                    name    spindle  offset rotation tool        min    sec
LINE = re.compile(r"^\s*(\S+?)_2([HV])\s+(\d)(\d)(\d{3})\s*:=\s*(\d+):(\d+(?:\.\d+)?)\s*$", re.I)


def parse_ops(text):
    h, v, errors = [], [], []
    for number, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        m = LINE.match(raw)
        if not m:
            errors.append("Line {} not recognized: {}".format(number, raw))
            continue
        op = {
            "text": raw.strip(),
            "spindle": m.group(2).upper(),
            "offset": int(m.group(3)),
            "rotation": int(m.group(4)),
            "tool": int(m.group(5)),
            "seconds": int(m.group(6)) * 60 + float(m.group(7)) + SAFETY_SECONDS,
        }
        (h if op["spindle"] == "H" else v).append(op)
    return h, v, errors


# ---- 2. Cut H into stretches between B events --------------------------------
# A stretch = the H ops cut at one rotation with one tool. Every stretch
# except possibly the first starts with a B event, whose lockout V sits out.
def event_lockout(prev, op):
    """Lockout seconds for the B event before `op`, or None if there is none."""
    if prev is None:
        return TOOL_CHANGE_LOCKOUT_SECONDS if START_IS_B_EVENT else None
    if prev["tool"] != op["tool"]:
        return TOOL_CHANGE_LOCKOUT_SECONDS
    if prev["rotation"] != op["rotation"]:
        return ROTATE_LOCKOUT_SECONDS
    return None


def h_stretches(h):
    stretches = []
    for i, op in enumerate(h):
        lockout = event_lockout(h[i - 1] if i else None, op)
        is_event = lockout is not None
        if not stretches or is_event:
            stretches.append({"ops": [], "seconds": 0.0, "event": is_event, "lockout": lockout or 0})
        stretches[-1]["ops"].append(op)
        stretches[-1]["seconds"] += op["seconds"]
    return stretches


# ---- 3. Spread V ops across the stretches -------------------------------------
# V runs: tool change, (WAIT), cut, tool change for the next op, (WAIT), cut...
# Its tool change happens before its (WAIT), while H is still cutting or
# moving the B. So for timing, each V op's tool change belongs to the op
# BEFORE it:
#   pre       = V's first tool change, before its first (WAIT)
#   piece j   = op j's cutting + the next op's tool change
# The (WAIT)s sit between pieces. For one stretch with V pieces totalling W:
#   cost = max(H time, lockout + W)
# and at the very first B event H also waits for V's first tool change (pre).
# cycle = sum of stretch costs. Every split of V's pieces is tried;
# best[s][j] = shortest time to finish stretches 0..s-1 with V pieces 0..j-1 done.
def v_tool_change(v, i):
    """Seconds of V op i's time that are a tool change (0 if same tool as op i-1)."""
    if i > 0 and v[i]["tool"] == v[i - 1]["tool"]:
        return 0
    return min(V_TOOL_CHANGE_SECONDS, v[i]["seconds"])


def v_pieces(v):
    """(pre, pieces) as described above."""
    tcs = [v_tool_change(v, j) for j in range(len(v))]
    pre = tcs[0] if v else 0.0
    pieces = [v[j]["seconds"] - tcs[j] + (tcs[j + 1] if j + 1 < len(v) else 0) for j in range(len(v))]
    return pre, pieces


def stretch_timing(s, stretch, w, pre):
    """(when V starts cutting, stretch cost), both from the start of stretch s,
    for V pieces totalling w seconds."""
    if s == 0 and not stretch["event"]:
        return pre, max(stretch["seconds"], pre + w)  # B already in place: V just runs
    lead = pre if s == 0 else 0  # first B event: H waits for V's first tool change
    v_start = lead + stretch["lockout"]
    return v_start, lead + max(stretch["seconds"], stretch["lockout"] + w)


def plan_v(stretches, v):
    S, n = len(stretches), len(v)
    pre, pieces = v_pieces(v)
    prefix = [0.0]  # prefix[j] = total of pieces 0..j-1
    for w in pieces:
        prefix.append(prefix[-1] + w)

    INF = float("inf")
    best = [[INF] * (n + 1) for _ in range(S + 1)]
    start = [[0] * (n + 1) for _ in range(S + 1)]  # where stretch s-1's V group began
    best[0][0] = 0.0

    for s in range(1, S + 1):
        stretch = stretches[s - 1]
        for j in range(n + 1):
            for i in range(j + 1):
                if best[s - 1][i] == INF:
                    continue
                _, cost = stretch_timing(s - 1, stretch, prefix[j] - prefix[i], pre)
                # "<" keeps the earliest split on ties, so V finishes as soon as it can.
                if best[s - 1][i] + cost < best[s][j]:
                    best[s][j] = best[s - 1][i] + cost
                    start[s][j] = i

    # Walk back from "all stretches done, all V done" to recover each group.
    groups = [None] * S
    j = n
    for s in range(S, 0, -1):
        i = start[s][j]
        groups[s - 1] = v[i:j]
        j = i
    return groups, best[S][n]


# ---- 4. Write the marked-up list ----------------------------------------------
def render(stretches, groups, cycle):
    h_lines, v_lines = [], []
    h_total = v_total = 0.0
    for stretch, group in zip(stretches, groups):
        if stretch["event"]:
            h_lines += ["(WAIT BEFORE)", "(WAIT AFTER)"]
            v_lines.append("(WAIT)")
        for op in stretch["ops"]:
            h_lines.append(op["text"])
            h_total += op["seconds"]
        for op in group:
            v_lines.append(op["text"])
            v_total += op["seconds"]
    summary = "(EST CYCLE {:.1f}S  H IDLE {:.1f}S  V IDLE {:.1f}S)".format(
        cycle, cycle - h_total, cycle - v_total)
    return "\n".join(h_lines + v_lines + [summary]) + "\n"


def timeline(stretches, groups, v):
    """One line per stretch: when it starts, what each spindle does, who waits."""
    pre, pieces = v_pieces(v)
    lines = []
    t = 0.0
    first_v = 0
    for s, (stretch, group) in enumerate(zip(stretches, groups)):
        n = len(group)
        w = sum(pieces[first_v:first_v + n])
        v_start, cost = stretch_timing(s, stretch, w, pre)
        kind = "start" if s == 0 and not stretch["event"] else (
            "tool change" if stretch["lockout"] == TOOL_CHANGE_LOCKOUT_SECONDS else "rotation")
        h_tools = "/".join("T{}".format(op["tool"]) for op in stretch["ops"])
        if n:
            ops = "op {}".format(first_v + 1) if n == 1 else "ops {}-{}".format(first_v + 1, first_v + n)
            v_text = "V {} {:.0f}-{:.0f}s".format(ops, t + v_start, t + v_start + w)
        else:
            v_text = "V nothing to cut"
        lines.append("{:>2}. {:>6.0f}s {:<11} H {:<8} {:>4.0f}s | {} | H waits {:.0f}s".format(
            s + 1, t, kind, h_tools, stretch["seconds"], v_text, cost - stretch["seconds"]))
        t += cost
        first_v += n
    lines.append("    {:>6.0f}s end of cycle  (V times include the tool change for its next op)".format(t))
    return lines


def main():
    if len(sys.argv) < 2:
        print("Usage: python sync_plan.py ops.txt")
        sys.exit(1)
    path = sys.argv[1]
    with open(path) as f:
        h, v, errors = parse_ops(f.read())
    if errors:
        print("\n".join(errors))
        sys.exit(1)
    if not h:
        print("No H operations found; nothing to sync.")
        sys.exit(1)

    stretches = h_stretches(h)
    groups, cycle = plan_v(stretches, v)
    output = render(stretches, groups, cycle)

    out_path = os.path.splitext(path)[0] + "_sync.txt"
    with open(out_path, "w") as f:
        f.write(output)
    print(output, end="")
    print("Written to " + out_path)
    print()
    print("\n".join(timeline(stretches, groups, v)))


if __name__ == "__main__":
    main()
