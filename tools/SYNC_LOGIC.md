# Sync tools: how they work and how to fix them

Two Python scripts, standard library only, nothing to install.

| File | Job |
|---|---|
| `sync_plan.py` | Reads the Mastercam op list, decides which V ops run alongside which H ops. |
| `sync_insert.py` | Uses that plan to put `(WAIT ...)` markers in the H and V programs, checks them, and turns them into macro code. |
| `example/` | Small example: `ops.txt`, `H_raw.nc`, `V_raw.nc`, plus the outputs. |
| `example/complex/` | 10 H + 12 V ops bouncing between part 1 (G54, #1003, W1) and part 2 (G55, #1004, W2), 5 B events. |
| `conformance/` | Reference cases with exact expected outputs, for checking a converted version (section 8). |
| `make_app_demo.py` | Rebuilds the app's **Sync example** (`src/nc/demo-complex.js`) from `example/complex`. Run it after changing that example. |

```
python sync_insert.py all  ops.txt H.nc V.nc    plan + markers + code in one go
python sync_insert.py mark ops.txt H.nc V.nc    plan + markers only  -> H_marked.nc, V_marked.nc
python sync_insert.py check H_marked.nc V_marked.nc  check markers only, writes nothing
python sync_insert.py code H_marked.nc V_marked.nc   markers -> code -> H_sync.nc, V_sync.nc
python sync_plan.py ops.txt                     just the plan, as a marked-up list
python tests/test_sync_plan.py                  self-checks (run after any change)
python tests/test_sync_insert.py
python tests/test_conformance.py
```

**With your own script:** run `mark`, then feed `H_marked.nc` / `V_marked.nc`
to your script. It replaces the markers (and does the rest of its job); `code`
here is only a stand-in for it. The planner decides *where*, your script
decides *what*.

```
op list + times --+
                  +--> sync_insert.py mark --> *_marked.nc --> (check) --> your script --> machine
H.nc, V.nc -------+
```

**Hand-fix path:** if a marker lands in the wrong place, move the marker line in
`H_marked.nc` / `V_marked.nc` by hand, then run `check`. It runs every check,
so a hand move that would hang the machine is caught before your script sees it.

Nothing is written when a check fails. Every problem prints with its line number.

---

## 1. The machine rules everything is built on

1. **H drives.** H has the longest run time and is the only spindle that moves the B.
2. **B event** = H changes **tool** or **rotation digit**.
   - Rotation only: retract, B indexes, cut.
   - Tool change: retract, B to safe spot, T, B back to cutting position.
3. **Nothing cuts while the B moves.** The B may not move until V is clear.
4. **V has no B.** A call before its G68 (`G65 P8887 ...`) reads the B position and works out the rotation, so V has to wait until H says the B is in position **before that call**. Because the angle is calculated at run time, a V op can run at any B position.
5. **One wait spot on V.** V changes tools while H is cutting or positioning, then at its one `(WAIT)` it releases H ("clear") and waits for the B, both in the same place. If H is already waiting there, it waits for V's tool change too; we accept losing those few seconds for now.
6. **Each spindle keeps its op order.** The list is the run order.
7. **Part-off skips:** each op has `IF[#100xEQ1]GOTOn` jumping to its own `Nn`. `#1003` = offset 1, `#1004` = offset 2. **Sync code must never be between the IF and the N**, or a skipped part leaves the other spindle waiting forever.

If one of these turns out wrong, section 6 says where it lives in the code.

---

## 2. The op list

```
FAM_2H 12002 := 00:35
       ^^^^^    ^^ ^^
       |||└┴┴ tool (3 digits)
       ||└ rotation digit (H: real B position; V: only counts plane changes, ignored)
       |└ offset digit (which part -> which skip variable)
       └ _2H / _2V spindle
time = minutes:seconds from backplot (tool change included); SAFETY_SECONDS is added
```

---

## 3. The plan (sync_plan.py)

**Step 1, cut H into stretches.** Walk the H ops in order. Every B event starts
a new stretch. A stretch is "H at one position with one tool".

**Step 2, give each stretch a group of V ops.** V's order is fixed, so the only
choice is where to cut V's list into groups (a group can be empty).

V runs: tool change, `(WAIT)`, cut, tool change for the next op, `(WAIT)`, cut...
So for timing, each V op's tool change belongs to the op **before** it:

```
pre      = V's first tool change (before its first wait)
piece j  = op j's cutting  +  the next op's tool change
```

For one stretch whose V pieces add up to W:

```
stretch time = max( H time , lockout + W )
cycle        = sum of all stretch times   (+ pre at the first B event: H waits for V's first tool change)
```

`lockout` = seconds V cannot cut at the start of a stretch (B moving):
`ROTATE_LOCKOUT_SECONDS` or `TOOL_CHANGE_LOCKOUT_SECONDS`.
`V_TOOL_CHANGE_SECONDS` = how much of a V op's backplot time is its tool change
(only when it changes tool; same-tool ops have none). The formula lives in
`v_pieces` and `stretch_timing`.

Since `cycle = H total + time H spends waiting`, **the shortest cycle is the
same as the least H idle**. That is the "H always runs, V gets mixed in" goal.
When V has to be pushed back to the next stretch, the planner does it.

**Step 3, try every cut.** The planner tries every way to cut V's list
(dynamic programming, the `best[s][j]` table in `plan_v`) and keeps the one
with the shortest cycle. A couple of dozen ops takes no time at all. On a tie,
V goes as early as possible.

**Worked example** (6 s safety, 10 s tool-change lockout, 8 s V tool change):

```
H: T1 54 s -> 60 | T2 24 s -> 30          two stretches (tool change)
V: T10 20, T11 30, T12 10 (after +6)      every V op changes tool
pre 8 | pieces 20-8+8 = 20, 30-8+8 = 30, 10-8 = 2
Stretch 1: 8 + max(60, 10 + 20 + 30) = 68
Stretch 2:     max(30, 10 + 2)       = 30      cycle 98
Other cut, only T10 in stretch 1: 8 + max(60, 10+20) + max(30, 10+30+2) = 110   (worse)
```

**Timeline printout.** Both scripts print one line per stretch so you can
check the line-up against the machine. V's times include the tool change for
its next op:

```
 1.      0s tool change H T1         66s | V ops 1-2 18-75s | H waits 9s
 2.     75s tool change H T2         56s | V op 3 85-131s | H waits 0s
 3.    131s tool change H T3         76s | V ops 4-5 141-190s | H waits 0s
       207s end of cycle
```

If "H waits" is not 0, V's work in that stretch is longer than H's. Fix it by
splitting that V toolpath in Mastercam, or by moving a V op to a stretch with room.

---

## 4. Where the markers go (sync_insert.py, `mark`)

The list and the program are matched **by order**: the 3rd H line in the list
is the 3rd op in H.nc. An op is everything up to and including an **N label
alone on a line** (`N3`). The counts must match. Each op is also checked
against its list line to catch the two getting out of step or a part mix-up:

- T number = the list's tool
- work offset = `G54` for offset 1, `G55` for offset 2
- skip variable = `#1003` for offset 1, `#1004` for offset 2, and the GOTO goes to the op's own N
- V's B calculation `G65 P8887 W_` = `W1` for offset 1, `W2` for offset 2

A mismatch is a warning with the line number. It doesn't stop the run, but read it.

**H, for each op that starts a B event:**
- `(WAIT BEFORE)` goes in front of the op's **first B or T line** (the safe-spot move counts).
- `(WAIT AFTER)` goes after its **last B or T line** (B back at cutting position).
- Both must be above the skip line. A B or T after the skip line is an error.

**V, one `(WAIT)` per B event:**
- In the first V op cut in that stretch, in front of its **first line that needs
  the B**: after the tool call and modal codes, before the B calculation call
  (`G65 P8887`), G68 and the skip line. See the safe list in section 5.
- If V cuts nothing in a stretch, its `(WAIT)` stacks up in front of the next
  V op, or before M30 if V has no ops left. V still has to answer every B event.

The Nth V `(WAIT)` pairs with the Nth H `(WAIT BEFORE)/(WAIT AFTER)`.

---

## 5. The code (sync_insert.py, `code`)

Two shared variables, one per direction, set to the event number `k`:

| Var | Written by | Means |
|---|---|---|
| `#501` (`V_CLEAR_VAR`) | V | "I'm clear for B event k" |
| `#502` (`B_READY_VAR`) | H | "B is in position for event k" |

```
H                                     V
(WAIT BEFORE) becomes:                T12             <- tool change while H cuts / positions
  WHILE[#501NEk]DO1                   (WAIT) becomes:
  G4P100                                #501=k          <- release H if it is waiting
  END1                                  WHILE[#502NEk]DO1   <- wait for the B if needed
...retract / B / T / B back...          G4P100
(WAIT AFTER) becomes:                   END1
  #502=k                              G65 P8887 W1    <- B calculation, B is ready
                                      G68 ...
```

**What V may do before the B is ready** (`needs_b_in_position`): only its tool
call, modal G codes (G0/G1 with no axis words, G17-19, G20/21, G40, G49, G54-59,
G80, G90/91, G94/95) and M3/4/5/6/8/9. Anything else waits for the B first:
the B calculation call, any G65/M98 or custom M call, G68, axis moves, the skip
line, macro logic. It is a safe list on purpose: a line the script doesn't know
can only make V wait a little longer, never calculate or move too early. To
allow more, add to `SAFE_BEFORE_B_G` / `SAFE_BEFORE_B_M`.

Why a number `k` and not just 1/0: each event has its own value, so an
old "clear" from event 2 can never be read as "clear" for event 3.

**Stacked V waits:** each `(WAIT)` is a complete handshake, so V finishes
waiting for "B ready k" before it says "clear k+1". Otherwise it could
overwrite `#501=k` before H read it, and H would wait forever.

**Reset:** before M30, H sets `#501=0` and V sets `#502=0`. Each side clears
the variable it *reads*, after its last wait. The other side never writes that
variable again in this cycle, so the reset can't erase anything still needed.

**Aborted cycle:** if a cycle is reset partway through, `#501`/`#502` keep
whatever value they had. **Set both to 0 in MDI before the next cycle start.**

---

## 6. When something is wrong: where to change it

| Problem | Change this |
|---|---|
| List line "not recognized" | `LINE` pattern in `sync_plan.py` (`parse_ops`) |
| Time needs a different safety margin | `SAFETY_SECONDS` |
| Plan puts too much / too little V in a stretch | `ROTATE_LOCKOUT_SECONDS`, `TOOL_CHANGE_LOCKOUT_SECONDS`, `V_TOOL_CHANGE_SECONDS` |
| How a stretch's time is worked out | `v_pieces` and `stretch_timing` in `sync_plan.py` (the planner, the timeline and the brute-force test use them) |
| B already in position at cycle start | `START_IS_B_EVENT = False` |
| Another kind of B event (e.g. offset change) | `event_lockout` in `sync_plan.py` |
| Different variables, dwell or code text | settings and the `*_code` functions at the top of `sync_insert.py` |
| Skip variable numbering | `SKIP_VAR_BASE`; skip line format: `SKIP` pattern |
| Work offset / B calculation call checks | `WORK_OFFSET_BASE`, `B_CALC_CALL`, `check_offset` |
| H marker in the wrong place | the "WAIT BEFORE goes ahead of the first B or T" block in `mark` |
| V waits for the B too early / too late | `SAFE_BEFORE_B_*` lists and `needs_b_in_position` |
| V `(WAIT)` in the wrong place | `v_wait_position` |
| Ops counted wrong (post puts N on every line) | `N_LABEL` and `split_ops` |

After any change: run both test files. If one fails, it either found a bug in
the change, or the rule really changed. In that case update the test so it
says the new rule.

---

## 7. Known limits

- The plan never reorders ops. Move ops in Mastercam and re-run.
- Times are only as good as backplot.
- V's tool change is never overlapped with the B move (one wait spot, after the
  tool change). That costs a few seconds whenever H is waiting on V's tool
  change. Splitting V's wait into "clear before tool change" and "wait for B
  after it" would win them back; not done for now.
- `WHILE ... DO1` is used for every wait. Don't put sync markers inside another `DO1` loop.
- The scripts check structure, not cutting. Prove the first part of every new
  program the normal way: simulator, then single block / dry run through the first syncs.

---

## 8. Converting the script: proving your version matches

`conformance/cases/` holds 9 reference cases. Each has the inputs
(`ops.txt`, `H.nc`, `V.nc`) and, in `expected/`, exactly what the Python
produces:

| Case | What it covers |
|---|---|
| 01_simple | the small example: tool change, rotation only, part 1 and 2 |
| 02_complex | 10 H + 12 V ops bouncing G54/G55, 5 B events |
| 03_v_longer_than_h | V can't fit; H has to wait (timeline shows how long) |
| 04_stacked_waits | V runs out of work: 4 `(WAIT)`s stacked before M30 |
| 05_v_same_tool | 5 same-tool V ops split across a B event |
| 06_no_v_ops | no V ops at all: V still answers every B event |
| 07_error_list_out_of_step | list has an op the program doesn't: error, no output |
| 08_error_b_after_skip | B move after a skip line: error, no output |
| 09_warning_part_mixup | part 2 op calls `G65 P8887 W1`: warning, output still written |

Your converted version is right when, **with the settings listed at the top
of each `expected/report.txt`**, for every case:

1. It writes the same `H_marked.nc` and `V_marked.nc`, byte for byte:
   `fc /b mine\H_marked.nc cases\02_complex\expected\H_marked.nc` should say "no differences".
   The expected files use LF line endings (Git keeps them exactly as they are).
   If your version writes CRLF, compare with plain `fc` instead of `fc /b`.
2. Its timeline has the same numbers (start, H waits, end of cycle).
3. It gives the same errors and warnings on the same lines (the wording can differ).
4. For 07 and 08 it writes no marked files at all.

Convert one part at a time and check as you go. Parsing and stretches first
(compare the H markers), then the V split (compare the V markers), then the
checks (cases 07-09).

If you change the logic on purpose, the expected files have to change too: run
`python conformance/build.py` to rewrite them, and `python conformance/build.py --check`
to see which cases changed. `tests/test_conformance.py` runs that check.

---

## 9. Checking the times on the machine

Wrong times never make the sync unsafe. They only make the plan less good:
one spindle waits longer than it had to. To get the settings right, measure
them with the Fanuc millisecond clock `#3001` during a prove-out cycle.

Add these lines by hand (or have your script add them for a test run). Use
variables that are free on your machine; `#700`-`#799` below are only an example.

```
H, at (WAIT BEFORE) for event k:
  #110=#3001                       (H arrives)
  WHILE[#501NEk]DO1 ... END1
  #[720+k]=[#3001-#110]/1000       (seconds H waited for V at event k)
  #111=#3001                       (B move starts)
  ...safe spot / T / B back...
  #[700+k]=[#3001-#111]/1000       (lockout for event k)
  #502=k

V, around a tool change:
  #112=#3001
  T12
  #[740+k]=[#3001-#112]/1000       (V tool change seconds)

H, whole cycle:
  #113=#3001                       (first line)
  #799=[#3001-#113]/1000           (just before M30)
```

After the cycle, read them on the macro variable screen and compare them with
the timeline the script printed:

| Measured | Compare with | Change |
|---|---|---|
| `#701`... on tool-change events | timeline lockout | `TOOL_CHANGE_LOCKOUT_SECONDS` |
| `#70x` on rotation-only events | | `ROTATE_LOCKOUT_SECONDS` |
| `#741`... | | `V_TOOL_CHANGE_SECONDS` |
| `#721`... | "H waits" for that event | if much higher, V's backplot times are short |
| `#799` | "end of cycle" | overall check |

Use the typical value, not the worst one, then run `mark` again. If H waits
a lot longer than planned at one event, the V ops in that stretch run longer
than their backplot times. Add more margin to those ops, or raise `SAFETY_SECONDS`.
