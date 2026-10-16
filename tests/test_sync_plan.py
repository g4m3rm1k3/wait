"""
Checks for tools/sync_plan.py.   Run:  python tests/test_sync_plan.py

1. A small hand-worked example you can follow with a calculator.
2. Brute force: on random lists, try every way to split V and confirm the
   planner's cycle is never beaten.
3. Replay: read the planner's OUTPUT TEXT the way the machine would and
   confirm the cycle time matches and every B event has its markers.
"""
import itertools
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import sync_plan as sp  # noqa: E402


def plan(text):
    h, v, errors = sp.parse_ops(text)
    assert not errors, errors
    stretches = sp.h_stretches(h)
    groups, cycle = sp.plan_v(stretches, v)
    return stretches, groups, cycle, sp.render(stretches, groups, cycle)


def replay(output):
    """Run the marked-up list like the machine: returns (cycle, h_busy, v_busy)."""
    h_steps, v_steps, h_ops = [], [], []
    for line in output.splitlines():
        if line in ("(WAIT BEFORE)", "(WAIT AFTER)"):
            h_steps.append(line)
        elif line == "(WAIT)":
            v_steps.append(line)
        elif line.startswith("(EST"):
            continue
        else:
            m = sp.LINE.match(line)
            seconds = int(m.group(6)) * 60 + float(m.group(7)) + sp.SAFETY_SECONDS
            if m.group(2).upper() == "H":
                h_steps.append(seconds)
                h_ops.append({"tool": int(m.group(5)), "rotation": int(m.group(4))})
            else:
                v_steps.append((seconds, int(m.group(5))))

    # Split each spindle's steps into segments at its waits.
    def segments(steps, marker):
        segs = [[]]
        for step in steps:
            if step == marker:
                segs.append([])
            elif step not in ("(WAIT BEFORE)", "(WAIT AFTER)", "(WAIT)"):
                segs[-1].append(step)
        return segs

    h_segs = segments([s for s in h_steps if s != "(WAIT AFTER)"], "(WAIT BEFORE)")
    # Segment 0 runs before any wait. Then for each B event: the B moves once
    # both spindles have arrived; V restarts after the lockout; H's own ops
    # (backplot includes the index/tool change) restart when the B starts.
    # The lockout comes from the H ops on either side of the markers.
    # V's tool change happens before the (WAIT)s in front of its op: move each
    # op's tool-change seconds ahead of that run of waits.
    flat = []  # V in program order: "W" or [seconds, tool]
    for item in v_steps:
        flat.append("W" if item == "(WAIT)" else list(item))
    v_items = []  # "W" or seconds of V work
    prev_tool = None
    for index, item in enumerate(flat):
        if item == "W":
            v_items.append("W")
            continue
        seconds, tool = item
        tc = min(sp.V_TOOL_CHANGE_SECONDS, seconds) if tool != prev_tool else 0
        prev_tool = tool
        q = len(v_items)
        while q > 0 and v_items[q - 1] == "W":
            q -= 1
        v_items.insert(q, tc)
        v_items.append(seconds - tc)
    v_segs = [[]]
    for item in v_items:
        if item == "W":
            v_segs.append([])
        else:
            v_segs[-1].append(item)
    assert len(h_segs) == len(v_segs), "H rotations and V waits do not pair up"

    t_h = sum(h_segs[0])
    t_v = sum(v_segs[0])
    first = len(h_segs[0])  # index of the first H op after this event
    for h_seg, v_seg in zip(h_segs[1:], v_segs[1:]):
        prev = h_ops[first - 1] if first else None
        if first:
            lockout = sp.TOOL_CHANGE_LOCKOUT_SECONDS if prev["tool"] != h_ops[first]["tool"] else sp.ROTATE_LOCKOUT_SECONDS
        else:
            lockout = sp.TOOL_CHANGE_LOCKOUT_SECONDS  # B moves at cycle start
        b_start = max(t_h, t_v)  # B cannot move until V is done cutting
        t_h = b_start + sum(h_seg)
        t_v = b_start + lockout + sum(v_seg)
        first += len(h_seg)
    return max(t_h, t_v)


def brute_force_best(stretches, v):
    """Try every ordered split of V into one group per stretch."""
    n, S = len(v), len(stretches)
    pre, pieces = sp.v_pieces(v)
    best = float("inf")
    for cuts in itertools.combinations_with_replacement(range(n + 1), S - 1):
        bounds = (0,) + cuts + (n,)
        total = 0.0
        for s, stretch in enumerate(stretches):
            i, j = bounds[s], bounds[s + 1]
            total += sp.stretch_timing(s, stretch, sum(pieces[i:j]), pre)[1]
        best = min(best, total)
    return best


def random_list(rng):
    lines = []
    tool, rotation = 1, 1
    for _ in range(rng.randint(1, 8)):
        if rng.random() < 0.4:
            tool += 1
        if rng.random() < 0.3:
            rotation = rng.randint(1, 4)
        lines.append("FAM_2H 1{}{:03d} := 00:{:02d}".format(rotation, tool, rng.randint(1, 90)))
    for i in range(rng.randint(0, 8)):
        lines.append("FAM_2V 1{}{:03d} := {:02d}:{:02d}".format(rng.randint(1, 9), 10 + i, rng.randint(0, 1), rng.randint(0, 59)))
    rng.shuffle(lines)  # the planner must keep each spindle's order regardless
    return "\n".join(lines)


class ParseTests(unittest.TestCase):
    def test_digits_and_time(self):
        h, v, errors = sp.parse_ops("FAM_2H 21013 := 01:30\nFAM_2V 11015 := 00:03\n")
        self.assertEqual(errors, [])
        self.assertEqual((h[0]["offset"], h[0]["rotation"], h[0]["tool"]), (2, 1, 13))
        self.assertEqual(h[0]["seconds"], 90 + sp.SAFETY_SECONDS)
        self.assertEqual(v[0]["seconds"], 3 + sp.SAFETY_SECONDS)

    def test_bad_line_is_reported_with_its_line_number(self):
        _, _, errors = sp.parse_ops("FAM_2H 11001 := 00:04\nFAM_2H 1100 := 00:04\n")
        self.assertEqual(len(errors), 1)
        self.assertIn("Line 2", errors[0])


class HandWorkedExample(unittest.TestCase):
    def test_small_list(self):
        # With 6 s safety, 10 s tool-change lockout, 8 s V tool change:
        #   H: T1 rot1 54+6=60 | T2 rot1 24+6=30   -> 2 stretches (tool change)
        #   V: T10 14+6=20, T11 24+6=30, T12 4+6=10   (every V op changes tool)
        # V changes tool BEFORE its wait, so each op's 8 s tool change moves to
        # the op before it:  pre 8 | pieces 20-8+8=20, 30-8+8=30, 10-8=2
        #   stretch 1: H waits pre 8, then max(60, 10 + 20+30) = 60   -> 68
        #   stretch 2: max(30, 10 + 2) = 30                            cycle = 98
        # Any other split is slower, e.g. only V1 in stretch 1:
        #   8 + max(60, 10+20) + max(30, 10+30+2) = 68 + 42 = 110
        text = "\n".join([
            "FAM_2H 11001 := 00:54",
            "FAM_2V 11010 := 00:14",
            "FAM_2V 11011 := 00:24",
            "FAM_2H 11002 := 00:24",
            "FAM_2V 11012 := 00:04",
        ])
        _, groups, cycle, output = plan(text)
        self.assertEqual(cycle, 98)
        self.assertEqual([len(g) for g in groups], [2, 1])
        self.assertEqual(output.splitlines()[:8], [
            "(WAIT BEFORE)", "(WAIT AFTER)", "FAM_2H 11001 := 00:54",
            "(WAIT BEFORE)", "(WAIT AFTER)", "FAM_2H 11002 := 00:24",
            "(WAIT)", "FAM_2V 11010 := 00:14",
        ])


class LockoutTests(unittest.TestCase):
    def test_rotation_only_uses_the_shorter_lockout(self):
        # Same tool, new rotation: retract + one index, so V loses only 4 s.
        #   H: T1 rot1 20+6=26 | T1 rot2 40+6=46
        #   V: T11 30+6=36 -> pre 8 (tool change before first wait), piece 28
        #   stretch 1: 8 + max(26, 10 + 0) = 34
        #   stretch 2: max(46, 4 + 28) = 46                   cycle = 80
        text = "FAM_2H 11001 := 00:20\nFAM_2H 12001 := 00:40\nFAM_2V 11011 := 00:30\n"
        stretches, groups, cycle, _ = plan(text)
        self.assertEqual([s["lockout"] for s in stretches], [sp.TOOL_CHANGE_LOCKOUT_SECONDS, sp.ROTATE_LOCKOUT_SECONDS])
        self.assertEqual([len(g) for g in groups], [0, 1])
        self.assertEqual(cycle, 80)


class ToolChangeLineUp(unittest.TestCase):
    def test_v_tool_change_runs_before_its_wait(self):
        # H: T1 60 | T2 60.  V: T11 50 then T12 44 (after +6), 8 s tool changes.
        # pre 8 | pieces 50-8+8=50 (T11 cut + T12 change), 44-8=36
        #   stretch 1: 8 + max(60, 10 + 50) = 68
        #   stretch 2: max(60, 10 + 36) = 60                  cycle = 128
        text = "FAM_2H 11001 := 00:54\nFAM_2H 11002 := 00:54\nFAM_2V 11011 := 00:44\nFAM_2V 11012 := 00:38\n"
        stretches, groups, cycle, _ = plan(text)
        self.assertEqual([len(g) for g in groups], [1, 1])
        self.assertEqual(cycle, 128)
        self.assertEqual(sp.timeline(stretches, groups, sp.parse_ops(text)[1])[-1].split()[0], "128s")


class RandomLists(unittest.TestCase):
    def test_planner_is_optimal_and_its_output_replays_to_the_same_cycle(self):
        rng = random.Random(1)
        for _ in range(500):
            text = random_list(rng)
            stretches, groups, cycle, output = plan(text)
            h, v, _ = sp.parse_ops(text)

            # Nothing lost, nothing reordered.
            self.assertEqual([op["text"] for g in groups for op in g], [op["text"] for op in v])
            # Optimal: no split of V beats it.
            self.assertAlmostEqual(cycle, brute_force_best(stretches, v), places=6, msg=text)
            # The text the machine would get reproduces the same cycle.
            self.assertAlmostEqual(replay(output), cycle, places=6, msg=text)

            # Every H tool or rotation change has a marker pair right before it.
            lines = output.splitlines()
            h_ops = [i for i, line in enumerate(lines) if "_2H" in line]
            for a, b in zip(h_ops, h_ops[1:]):
                prev, op = sp.LINE.match(lines[a]), sp.LINE.match(lines[b])
                changed = prev.group(4) != op.group(4) or prev.group(5) != op.group(5)
                self.assertEqual(lines[b - 2:b] == ["(WAIT BEFORE)", "(WAIT AFTER)"], changed, msg=output)


if __name__ == "__main__":
    unittest.main()
