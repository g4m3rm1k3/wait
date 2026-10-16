"""
Sync inserter: puts the wait codes into the H and V programs.

Two steps, which can run together or separately:

  1. MARK   python sync_insert.py mark ops.txt H.nc V.nc
            Runs the planner (sync_plan.py) and writes H_marked.nc and
            V_marked.nc with (WAIT BEFORE) / (WAIT AFTER) / (WAIT) comment
            lines where the plan says. Open them and move a marker by hand
            if something is wrong.

  2. CODE   python sync_insert.py code H_marked.nc V_marked.nc
            Checks the markers and replaces them with the macro code.
            Writes H_sync.nc and V_sync.nc. Works on markers you placed by
            hand too.

            python sync_insert.py all ops.txt H.nc V.nc     does both.

  CHECK    python sync_insert.py check H_marked.nc V_marked.nc
            Runs every check on marked files and writes nothing. Use it after
            moving a marker by hand, before your own script turns the markers
            into code.

Nothing is written if a check fails; every problem is printed with its line.
See SYNC_LOGIC.md for how and why it works.

What one B event k becomes:

  H                                       V
  (SYNC k - WAIT FOR V CLEAR)             T12          (tool change while H cuts/moves B)
  WHILE[#501NEk]DO1                       #501=k (SYNC k - V CLEAR)       <- (WAIT)
  G4P100                                  WHILE[#502NEk]DO1 (SYNC k - WAIT FOR B)
  END1                                    G4P100
  ...retract / B / T / B back...          END1
  #502=k (SYNC k - B IN POSITION)         G65 P8887 W1 (B calculation)
                                          G68 ...

V's one (WAIT) spot: release H if H is waiting, then wait for the B if it is
not there yet. It sits after V's tool change and before the first line that
needs the B (the B calculation call).

Before M30, H sets #501=0 and V sets #502=0 for the next cycle.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync_plan as plan  # noqa: E402

# ---- Settings ---------------------------------------------------------------
V_CLEAR_VAR = 501  # V sets it to k: "V is clear for B event k". H waits on it.
B_READY_VAR = 502  # H sets it to k: "B is in position for event k". V waits on it.
DWELL = "G4P100"  # inside each wait loop (P is milliseconds on most Fanucs)
SKIP_VAR_BASE = 1002  # part-off skip variable = base + offset digit (1 -> #1003)
WORK_OFFSET_BASE = 53  # work offset = G(base + offset digit): 1 -> G54, 2 -> G55
B_CALC_CALL = "P8887"  # V's B calculation call; its W number = offset digit

MARK_BEFORE = "(WAIT BEFORE)"
MARK_AFTER = "(WAIT AFTER)"
MARK_V = "(WAIT)"


# ---- The code each marker turns into ----------------------------------------
def h_wait_before_code(k):
    return [
        "(SYNC {} - WAIT FOR V CLEAR)".format(k),
        "WHILE[#{}NE{}]DO1".format(V_CLEAR_VAR, k),
        DWELL,
        "END1",
    ]


def h_wait_after_code(k):
    return ["#{}={} (SYNC {} - B IN POSITION)".format(B_READY_VAR, k, k)]


def v_wait_code(k):
    return [
        "#{}={} (SYNC {} - V CLEAR)".format(V_CLEAR_VAR, k, k),
        "WHILE[#{}NE{}]DO1 (SYNC {} - WAIT FOR B)".format(B_READY_VAR, k, k),
        DWELL,
        "END1",
    ]


# Each side clears the variable it READS, after its last wait, so the next
# cycle cannot see an old value. Safe because the other side never writes
# that variable again this cycle.
def h_reset_code():
    return ["#{}=0 (SYNC RESET)".format(V_CLEAR_VAR)]


def v_reset_code():
    return ["#{}=0 (SYNC RESET)".format(B_READY_VAR)]


# ---- Reading NC lines --------------------------------------------------------
COMMENT = re.compile(r"\([^)]*\)|;.*")
B_WORD = re.compile(r"(?<![A-Z])B\s*[-+]?[\d.#\[]")
T_WORD = re.compile(r"(?<![A-Z])T\s*(\d+)")
N_LABEL = re.compile(r"^N\s*(\d+)$")  # an op ends with its N label alone on a line
SKIP = re.compile(r"^IF\s*\[\s*#\s*(\d+)\s*EQ\s*1\s*\]\s*GOTO\s*(\d+)$")
FEED_MOVE = re.compile(r"(?<![A-Z])G\s*0*[123](?!\d)")
WORD = re.compile(r"([A-Z])\s*([-+]?\d*\.?\d*)")
# What V may run BEFORE the B is in position: its tool call, modal G codes
# and spindle / coolant / tool-change M codes. Everything else waits for the B:
# axis moves, G68, the B calculation call (G65 P8887), any G65 / M98 call,
# the skip line and macro logic.
SAFE_BEFORE_B_LETTERS = set("GMTSF")
SAFE_BEFORE_B_G = {0, 1, 17, 18, 19, 20, 21, 40, 49, 54, 55, 56, 57, 58, 59, 80, 90, 91, 94, 95}
SAFE_BEFORE_B_M = {3, 4, 5, 6, 8, 9}
PROGRAM_END = re.compile(r"(?<![A-Z])M\s*0*(?:2|30)(?!\d)")
G68 = re.compile(r"(?<![A-Z])G\s*0*68(?!\d)")


def code_of(line):
    """The line without comments, upper case: what the control executes."""
    return COMMENT.sub("", line).strip().upper()


def needs_b_in_position(code):
    """True unless the V line is on the short safe list above. Anything not
    recognized waits for the B, so a new kind of line can only make V wait
    longer, never move or calculate before the B is ready."""
    if is_header(code):  # blank, %, O number
        return False
    if "#" in code or "[" in code:
        return True
    words = WORD.findall(code)
    if "".join(letter + value for letter, value in words) != code.replace(" ", ""):
        return True  # something that is not plain address words
    for letter, value in words:
        if letter not in SAFE_BEFORE_B_LETTERS:
            return True
        if letter in "GM":
            try:
                number = float(value)
            except ValueError:
                return True
            if number != int(number):
                return True
            if letter == "G" and int(number) not in SAFE_BEFORE_B_G:
                return True
            if letter == "M" and int(number) not in SAFE_BEFORE_B_M:
                return True
    return False


def is_header(code):
    return code in ("", "%") or re.match(r"^O\s*\d+$", code) is not None


def read_lines(path):
    with open(path, newline="") as f:
        text = f.read()
    eol = "\r\n" if "\r\n" in text else "\n"
    return text.splitlines(), eol


def write_lines(path, lines, eol):
    with open(path, "w", newline="") as f:
        f.write(eol.join(lines) + eol)


def split_ops(lines):
    """Cut a program into ops: each op runs through its N label line.
    Returns (ops, footer_start). ops[i] = {"start", "end" (the N line), "label"}."""
    ops = []
    start = 0
    for i, line in enumerate(lines):
        m = N_LABEL.match(code_of(line))
        if m:
            ops.append({"start": start, "end": i, "label": int(m.group(1))})
            start = i + 1
    return ops, start


def body_start(lines, op):
    """First line of the part of the op the skip can jump over: the
    IF[...]GOTO line, or the first feed move if there is no skip line."""
    for i in range(op["start"], op["end"]):
        if SKIP.match(code_of(lines[i])):
            return i
    for i in range(op["start"], op["end"]):
        if FEED_MOVE.search(code_of(lines[i])):
            return i
    return op["end"]


def program_end_line(lines, footer_start):
    for i in range(footer_start, len(lines)):
        if PROGRAM_END.search(code_of(lines[i])):
            return i
    return None


class Problems:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def error(self, name, index, message):
        self.errors.append("ERROR   {} line {}: {}".format(name, index + 1, message))

    def warn(self, name, index, message):
        self.warnings.append("WARNING {} line {}: {}".format(name, index + 1, message))

    def report(self):
        for line in self.errors + self.warnings:
            print(line)


def check_skip(lines, op, name, number, offset, problems):
    """The skip must jump to this op's own N label (so it never jumps over
    another op's sync code), and should use the offset's skip variable."""
    for i in range(op["start"], op["end"]):
        code = code_of(lines[i])
        m = SKIP.match(code)
        if m:
            if int(m.group(2)) != op["label"]:
                problems.error(name, i, "op {} skip jumps to N{} but the op ends at N{}.".format(number, m.group(2), op["label"]))
            if offset is not None and int(m.group(1)) != SKIP_VAR_BASE + offset:
                problems.warn(name, i, "op {} is offset {} but skips on #{} (expected #{}).".format(
                    number, offset, m.group(1), SKIP_VAR_BASE + offset))
        elif "GOTO" in code or code.startswith("[IF") or code.startswith("IF"):
            problems.warn(name, i, "skip line not recognized (expected IF[#10xxEQ1]GOTO{}): {}".format(op["label"], lines[i].strip()))


def check_offset(lines, op, name, number, offset, problems):
    """Each op runs on one part: its G54/G55 and the W of the B calculation
    call must match the list's offset digit (the skip variable is checked in
    check_skip). Catches ops that bounce between parts getting mixed up."""
    for i in range(op["start"], op["end"] + 1):
        code = code_of(lines[i])
        for m in re.finditer(r"(?<![A-Z])G\s*0*(5[4-9])(?![\d.])", code):
            if int(m.group(1)) != WORK_OFFSET_BASE + offset:
                problems.warn(name, i, "op {} is offset {} (G{}) but uses G{}.".format(
                    number, offset, WORK_OFFSET_BASE + offset, m.group(1)))
        if B_CALC_CALL in code.replace(" ", ""):
            w = re.search(r"(?<![A-Z])W\s*(\d+)", code)
            if w and int(w.group(1)) != offset:
                problems.warn(name, i, "op {} is offset {} but the B calculation uses W{}.".format(number, offset, w.group(1)))


def check_tool(lines, op, name, number, listed_tool, problems):
    """If the op calls a tool, it should be the one in the list; otherwise the
    list and the program are probably out of step."""
    for i in range(op["start"], op["end"] + 1):
        m = T_WORD.search(code_of(lines[i]))
        if m and int(m.group(1)) != listed_tool:
            problems.warn(name, i, "op {} calls T{} but the list says T{}. Is the list in the same order as the program?".format(
                number, int(m.group(1)), listed_tool))


# ---- Step 1: place markers from the plan ---------------------------------------
def mark(ops_text, h_lines, v_lines, problems):
    h_list, v_list, errors = plan.parse_ops(ops_text)
    for message in errors:
        problems.errors.append("ERROR   ops list: " + message)
    if errors or not h_list:
        if not h_list:
            problems.errors.append("ERROR   ops list: no H operations found.")
        return None, None, None
    stretches = plan.h_stretches(h_list)
    groups, cycle = plan.plan_v(stretches, v_list)

    h_ops, h_footer = split_ops(h_lines)
    v_ops, v_footer = split_ops(v_lines)
    if len(h_ops) != len(h_list):
        problems.error("H", 0, "program has {} ops (N label lines) but the list has {} H ops.".format(len(h_ops), len(h_list)))
    if len(v_ops) != len(v_list):
        problems.error("V", 0, "program has {} ops (N label lines) but the list has {} V ops.".format(len(v_ops), len(v_list)))
    if problems.errors:
        return None, None, None

    before = {}  # line index -> marker lines to put before it
    after = {}  # line index -> marker lines to put after it

    # H: which list ops start a B event (first op of an event stretch).
    starts_event = []
    for stretch in stretches:
        starts_event += [stretch["event"] and j == 0 for j in range(len(stretch["ops"]))]

    for number, (op, listed, event) in enumerate(zip(h_ops, h_list, starts_event), 1):
        check_skip(h_lines, op, "H", number, listed["offset"], problems)
        check_offset(h_lines, op, "H", number, listed["offset"], problems)
        check_tool(h_lines, op, "H", number, listed["tool"], problems)
        body = body_start(h_lines, op)
        moves = [i for i in range(op["start"], body)
                 if B_WORD.search(code_of(h_lines[i])) or T_WORD.search(code_of(h_lines[i]))]
        for i in range(body, op["end"]):
            if B_WORD.search(code_of(h_lines[i])) or T_WORD.search(code_of(h_lines[i])):
                problems.error("H", i, "op {} moves B or calls a tool after its skip line; that move would be skipped and cannot be synced. Put B/T before the IF line.".format(number))
        if event:
            if not moves:
                problems.error("H", op["start"], "op {} is a B event (tool or rotation change) but has no B or T before its skip line.".format(number))
                continue
            # WAIT BEFORE goes ahead of the first B or T (the safe-spot move counts);
            # WAIT AFTER goes after the last one (B back at cutting position).
            before.setdefault(moves[0], []).append(MARK_BEFORE)
            after.setdefault(moves[-1], []).append(MARK_AFTER)
        elif moves:
            problems.warn("H", moves[0], "op {} has a B or T word but the list says same tool and rotation as the op before, so it is not synced. Check the list.".format(number))

    h_marked = apply_inserts(h_lines, before, after)

    # V: one (WAIT) per B event, ahead of the first V op cut in that stretch.
    # Waits for stretches where V cuts nothing stack up in front of the next
    # V op, or before M30 if V has no ops left.
    before, after = {}, {}
    pending = []
    next_v = 0
    for stretch, group in zip(stretches, groups):
        if stretch["event"]:
            pending.append(MARK_V)
        if group:
            before.setdefault(v_wait_position(v_lines, v_ops[next_v]), []).extend(pending)
            pending = []
            next_v += len(group)
    if pending:
        end = program_end_line(v_lines, v_footer)
        if end is None:
            problems.error("V", len(v_lines) - 1, "no M30 / M2 after the last op to put the remaining waits in front of.")
            return None, None, None
        before.setdefault(end, []).extend(pending)

    for number, (op, listed) in enumerate(zip(v_ops, v_list), 1):
        check_skip(v_lines, op, "V", number, listed["offset"], problems)
        check_offset(v_lines, op, "V", number, listed["offset"], problems)
        check_tool(v_lines, op, "V", number, listed["tool"], problems)

    v_marked = apply_inserts(v_lines, before, after)
    return h_marked, v_marked, plan.timeline(stretches, groups, v_list)


def v_wait_position(lines, op):
    """V's (WAIT) goes in front of the op's first line that needs the B
    (see needs_b_in_position): after its tool call and modal codes, before
    the B calculation call, G68 and the skip line."""
    body = body_start(lines, op)
    return next((i for i in range(op["start"], body) if needs_b_in_position(code_of(lines[i]))), body)


def apply_inserts(lines, before, after):
    out = []
    for i, line in enumerate(lines):
        out += before.get(i, [])
        out.append(line)
        out += after.get(i, [])
    return out


# ---- Step 2: check markers and turn them into code ---------------------------
def is_marker(line, marker):
    return line.strip().upper() == marker


def check_markers_outside_skips(lines, name, problems):
    """No marker may sit between an op's skip line and its N label: when the
    part is off, the skip would jump over it and the other side would wait
    forever."""
    ops, _ = split_ops(lines)
    for number, op in enumerate(ops, 1):
        check_skip(lines, op, name, number, None, problems)
        body = None
        for i in range(op["start"], op["end"]):
            if SKIP.match(code_of(lines[i])):
                body = i
                break
        if body is None:
            continue
        for i in range(body, op["end"]):
            if any(is_marker(lines[i], m) for m in (MARK_BEFORE, MARK_AFTER, MARK_V)):
                problems.error(name, i, "marker is after op {}'s skip line; when that part is off the skip jumps over it and the other spindle waits forever. Move it above the IF line.".format(number))


def to_code(h_lines, v_lines, problems):
    check_markers_outside_skips(h_lines, "H", problems)
    check_markers_outside_skips(v_lines, "V", problems)

    h_out = []
    k = 0
    open_at = None  # line of the (WAIT BEFORE) still waiting for its (WAIT AFTER)
    for i, line in enumerate(h_lines):
        if is_marker(line, MARK_BEFORE):
            if open_at is not None:
                problems.error("H", i, "(WAIT BEFORE) again without a (WAIT AFTER) since line {}.".format(open_at + 1))
            k += 1
            open_at = i
            h_out += h_wait_before_code(k)
        elif is_marker(line, MARK_AFTER):
            if open_at is None:
                problems.error("H", i, "(WAIT AFTER) without a (WAIT BEFORE) above it.")
            open_at = None
            h_out += h_wait_after_code(k)
        elif is_marker(line, MARK_V):
            problems.error("H", i, "(WAIT) is the V marker; H uses (WAIT BEFORE) and (WAIT AFTER).")
        else:
            code = code_of(line)
            if open_at is None and (B_WORD.search(code) or T_WORD.search(code)):
                problems.warn("H", i, "B or T outside a (WAIT BEFORE)/(WAIT AFTER) pair. Fine only if the B is already there and V is safe.")
            h_out.append(line)
    if open_at is not None:
        problems.error("H", open_at, "(WAIT BEFORE) never gets its (WAIT AFTER).")

    # V: each (WAIT) is one complete handshake, "clear k" then "wait for B k",
    # so stacked waits finish event k before saying "clear k+1".
    v_out = []
    waits = 0
    for i, line in enumerate(v_lines):
        if is_marker(line, MARK_V):
            waits += 1
            v_out += v_wait_code(waits)
        elif is_marker(line, MARK_BEFORE) or is_marker(line, MARK_AFTER):
            problems.error("V", i, "(WAIT BEFORE)/(WAIT AFTER) are H markers; V uses (WAIT).")
        else:
            v_out.append(line)

    if waits != k:
        problems.error("V", 0, "V has {} (WAIT) but H has {} B events. They pair up by count, so they must match or a spindle waits forever.".format(waits, k))

    for name, out, reset in (("H", h_out, h_reset_code()), ("V", v_out, v_reset_code())):
        _, footer = split_ops(out)
        end = program_end_line(out, footer)
        if end is None:
            problems.error(name, len(out) - 1, "no M30 / M2 after the last op to put the sync reset in front of.")
        else:
            out[end:end] = reset
    return h_out, v_out


# ---- Command line ------------------------------------------------------------
def output_path(path, suffix):
    base = os.path.splitext(path)[0]
    if base.endswith("_marked"):
        base = base[: -len("_marked")]
    return base + suffix + ".nc"


def main(argv):
    usage = ("Usage:\n"
             "  python sync_insert.py mark ops.txt H.nc V.nc\n"
             "  python sync_insert.py code H_marked.nc V_marked.nc\n"
             "  python sync_insert.py check H_marked.nc V_marked.nc\n"
             "  python sync_insert.py all  ops.txt H.nc V.nc")
    if len(argv) < 2 or argv[1] not in ("mark", "code", "check", "all"):
        print(usage)
        return 1
    step = argv[1]
    problems = Problems()

    if step in ("code", "check"):
        if len(argv) != 4:
            print(usage)
            return 1
        h_path, v_path = argv[2], argv[3]
        (h_lines, h_eol), (v_lines, v_eol) = read_lines(h_path), read_lines(v_path)
        h_out, v_out = to_code(h_lines, v_lines, problems)
        problems.report()
        if step == "check":
            print("{} error(s), {} warning(s). Nothing written.".format(len(problems.errors), len(problems.warnings)))
            return 1 if problems.errors else 0
        if problems.errors:
            print("Nothing written.")
            return 1
        write_lines(output_path(h_path, "_sync"), h_out, h_eol)
        write_lines(output_path(v_path, "_sync"), v_out, v_eol)
        print("Written: {}  {}".format(output_path(h_path, "_sync"), output_path(v_path, "_sync")))
        return 0

    if len(argv) != 5:
        print(usage)
        return 1
    ops_path, h_path, v_path = argv[2], argv[3], argv[4]
    with open(ops_path) as f:
        ops_text = f.read()
    (h_lines, h_eol), (v_lines, v_eol) = read_lines(h_path), read_lines(v_path)
    for name, lines in (("H", h_lines), ("V", v_lines)):
        for i, line in enumerate(lines):
            if any(is_marker(line, m) for m in (MARK_BEFORE, MARK_AFTER, MARK_V)):
                problems.error(name, i, "already has markers. Use 'code' for a marked program, or start from the unmarked one.")
                break
    if problems.errors:
        problems.report()
        return 1

    h_marked, v_marked, report = mark(ops_text, h_lines, v_lines, problems)
    if h_marked is None or problems.errors:
        problems.report()
        print("Nothing written.")
        return 1
    print("\n".join(report))
    write_lines(output_path(h_path, "_marked"), h_marked, h_eol)
    write_lines(output_path(v_path, "_marked"), v_marked, v_eol)
    print("Written: {}  {}".format(output_path(h_path, "_marked"), output_path(v_path, "_marked")))

    if step == "all":
        h_out, v_out = to_code(h_marked, v_marked, problems)
        if problems.errors:
            problems.report()
            print("Markers written, but no code: fix the errors above, then run 'code'.")
            return 1
        write_lines(output_path(h_path, "_sync"), h_out, h_eol)
        write_lines(output_path(v_path, "_sync"), v_out, v_eol)
        print("Written: {}  {}".format(output_path(h_path, "_sync"), output_path(v_path, "_sync")))
    problems.report()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
