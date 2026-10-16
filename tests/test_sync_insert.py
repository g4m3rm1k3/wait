"""
Checks for tools/sync_insert.py.   Run:  python tests/test_sync_insert.py

Uses the example files in tools/example: ops.txt, H_raw.nc, V_raw.nc.
"""
import os
import sys
import unittest

TOOLS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools")
sys.path.insert(0, TOOLS)
import sync_insert as si  # noqa: E402


def example(name):
    with open(os.path.join(TOOLS, "example", name)) as f:
        return f.read()


def run_mark():
    problems = si.Problems()
    h, v, _ = si.mark(example("ops.txt"), example("H_raw.nc").splitlines(), example("V_raw.nc").splitlines(), problems)
    return h, v, problems


def index_of(lines, text, start=0):
    return next(i for i in range(start, len(lines)) if lines[i].strip() == text)


class MarkTests(unittest.TestCase):
    def test_example_marks_every_b_event_ahead_of_the_skip(self):
        h, v, problems = run_mark()
        self.assertEqual(problems.errors, [])
        self.assertEqual(problems.warnings, [])
        # Op 3 tool change: WAIT BEFORE ahead of the safe-spot move, WAIT AFTER after B back.
        safe = index_of(h, "G0 B45. (SAFE SPOT - PLACEHOLDER)")
        self.assertEqual(h[safe - 1], si.MARK_BEFORE)
        back = index_of(h, "G0 B90.", safe)
        self.assertEqual(h[back + 1], si.MARK_AFTER)
        self.assertEqual(h[back + 2], "IF[#1003EQ1]GOTO3")
        # Op 2 rotation only: retract runs before the wait, B90 inside the pair.
        retract = index_of(h, "(OP 2 - FAM_2H 12001 - OFFSET 1 - ROT 2 - T1 SAME TOOL - FACE SECOND SIDE)") + 1
        self.assertEqual(h[retract:retract + 4], ["G0 Z200.", si.MARK_BEFORE, "G0 B90.", si.MARK_AFTER])
        self.assertEqual(h.count(si.MARK_BEFORE), 3)
        self.assertEqual(v.count(si.MARK_V), 3)

    def test_list_and_program_out_of_step_is_an_error(self):
        problems = si.Problems()
        ops = example("ops.txt") + "FAM_2H 12002 := 00:10\n"
        si.mark(ops, example("H_raw.nc").splitlines(), example("V_raw.nc").splitlines(), problems)
        self.assertTrue(any("list has 4 H ops" in e for e in problems.errors))

    def test_b_move_after_the_skip_line_is_an_error(self):
        h = example("H_raw.nc").replace("G1 X60.", "G0 B180.")
        problems = si.Problems()
        si.mark(example("ops.txt"), h.splitlines(), example("V_raw.nc").splitlines(), problems)
        self.assertTrue(any("after its skip line" in e for e in problems.errors))

    def test_wrong_skip_variable_for_the_offset_is_a_warning(self):
        v = example("V_raw.nc").replace("IF[#1004EQ1]GOTO12", "IF[#1003EQ1]GOTO12")
        problems = si.Problems()
        si.mark(example("ops.txt"), example("H_raw.nc").splitlines(), v.splitlines(), problems)
        self.assertTrue(any("expected #1004" in w for w in problems.warnings))


class ComplexExample(unittest.TestCase):
    """tools/example/complex: 10 H and 12 V ops bouncing between part 1
    (G54, #1003, W1) and part 2 (G55, #1004, W2)."""

    def files(self):
        return [example(os.path.join("complex", name)) for name in ("ops.txt", "H_raw.nc", "V_raw.nc")]

    def test_runs_clean_and_every_handshake_pairs_up(self):
        ops, h, v = self.files()
        problems = si.Problems()
        h_marked, v_marked, _ = si.mark(ops, h.splitlines(), v.splitlines(), problems)
        self.assertEqual(problems.errors + problems.warnings, [])
        h_out, v_out = si.to_code(h_marked, v_marked, problems)
        self.assertEqual(problems.errors, [])
        events = h_out.count("END1")
        self.assertEqual(events, 5)
        self.assertEqual(v_out.count("END1"), events)

    def test_part_mix_ups_are_flagged(self):
        ops, h, v = self.files()
        for bad, expected in (
            (v.replace("(OP 6 - FAM_2V 22013 - G55 - T13)\nG0 G90 G55", "(OP 6 - FAM_2V 22013 - G55 - T13)\nG0 G90 G54"), "uses G54"),
            (v.replace("G65 P8887 W2\nG68 X0. Y0. R0.\nIF[#1004EQ1]GOTO106", "G65 P8887 W1\nG68 X0. Y0. R0.\nIF[#1004EQ1]GOTO106"), "uses W1"),
            (v.replace("IF[#1004EQ1]GOTO106", "IF[#1003EQ1]GOTO106"), "expected #1004"),
        ):
            self.assertNotEqual(bad, v, expected)
            problems = si.Problems()
            si.mark(ops, h.splitlines(), bad.splitlines(), problems)
            self.assertTrue(any(expected in w for w in problems.warnings), (expected, problems.warnings))


class CodeTests(unittest.TestCase):
    def test_marked_example_becomes_paired_macro_code(self):
        h, v, _ = run_mark()
        problems = si.Problems()
        h_out, v_out = si.to_code(h, v, problems)
        self.assertEqual(problems.errors, [])
        for k in (1, 2, 3):
            # H waits for V clear k, moves the B, then releases V for event k.
            wait = h_out.index("WHILE[#501NE{}]DO1".format(k))
            release = h_out.index("#502={} (SYNC {} - B IN POSITION)".format(k, k))
            self.assertLess(wait, release)
            # V: tool change, then clear k and wait for B k together, then the B calculation.
            clear = v_out.index("#501={} (SYNC {} - V CLEAR)".format(k, k))
            self.assertTrue(si.T_WORD.search(v_out[clear - 1]), "tool change right before the wait")
            self.assertEqual(v_out[clear + 1], "WHILE[#502NE{}]DO1 (SYNC {} - WAIT FOR B)".format(k, k))
            self.assertTrue(v_out[clear + 4].startswith("G65 P8887 W"))
        self.assertEqual(h_out[-3:], ["#501=0 (SYNC RESET)", "M30", "%"])
        self.assertEqual(v_out[-3:], ["#502=0 (SYNC RESET)", "M30", "%"])

    def test_no_sync_code_can_be_skipped(self):
        h, v, _ = run_mark()
        h_out, v_out = si.to_code(h, v, si.Problems())
        for lines in (h_out, v_out):
            ops, _ = si.split_ops(lines)
            for op in ops:
                body = si.body_start(lines, op)
                for line in lines[body:op["end"]]:
                    self.assertNotIn("SYNC", line)

    def test_stacked_v_waits_finish_each_handshake_before_the_next(self):
        # V cuts nothing for event 1: two waits in a row. V must wait for B 1
        # before saying clear 2, or H could miss "clear 1" and wait forever.
        v = ["%", si.MARK_V, si.MARK_V, "T5", "G68 X0. Y0. R0.", "G1 X1.", "N5", "M30", "%"]
        h = ["%", si.MARK_BEFORE, "G0 B0.", si.MARK_AFTER, "G1 X1.", "N1",
             si.MARK_BEFORE, "G0 B90.", si.MARK_AFTER, "G1 X1.", "N2", "M30", "%"]
        problems = si.Problems()
        _, v_out = si.to_code(h, v, problems)
        self.assertEqual(problems.errors, [])
        order = [line for line in v_out if "SYNC" in line]
        self.assertEqual(order, [
            "#501=1 (SYNC 1 - V CLEAR)", "WHILE[#502NE1]DO1 (SYNC 1 - WAIT FOR B)",
            "#501=2 (SYNC 2 - V CLEAR)", "WHILE[#502NE2]DO1 (SYNC 2 - WAIT FOR B)",
            "#502=0 (SYNC RESET)",
        ])

    def test_v_wait_goes_after_the_tool_change_and_before_the_b_calculation(self):
        # The call reads the B position, so the wait must come before it,
        # with or without arguments, and before any other kind of call.
        for call in ("G65 P8887 W1", "G65 P8887", "M98 P8887", "M100"):
            lines = ["(OP 2)", "G0 G90 G54", "T12", "M8", call, "G68 X0. Y0. R0.", "IF[#1003EQ1]GOTO12", "G1 X1.", "N12"]
            op = si.split_ops(lines)[0][0]
            self.assertEqual(lines[si.v_wait_position(lines, op)], call)

    def test_marker_after_a_skip_line_is_an_error(self):
        h = example("H_raw.nc").splitlines()
        v = example("V_raw.nc").splitlines()
        b90 = h.index("G0 B90.")
        h[b90:b90 + 2] = [si.MARK_BEFORE, "G0 B90.", "IF[#1003EQ1]GOTO2", si.MARK_AFTER]
        v.insert(v.index("T12"), si.MARK_V)
        problems = si.Problems()
        si.to_code(h, v, problems)
        self.assertTrue(any("after op 2's skip line" in e for e in problems.errors))

    def test_wait_counts_that_do_not_match_are_an_error(self):
        h, v, _ = run_mark()
        v.remove(si.MARK_V)
        problems = si.Problems()
        si.to_code(h, v, problems)
        self.assertTrue(any("V has 2 (WAIT) but H has 3" in e for e in problems.errors))

    def test_unrecognized_skip_line_is_a_warning(self):
        v = example("V_raw.nc").replace("IF[#1003EQ1]GOTO11", "[IF#1003EQ1]GOTO11").splitlines()
        h, _, _ = run_mark()
        problems = si.Problems()
        si.check_markers_outside_skips(v, "V", problems)
        self.assertTrue(any("skip line not recognized" in w for w in problems.warnings))


if __name__ == "__main__":
    unittest.main()
