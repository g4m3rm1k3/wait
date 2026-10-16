# C# planning code for the Mastercam add-in

The horizontal tool-change sequence moves B. Vertical cutting therefore stays blocked for the **whole B/tool-change/B-return sequence**. The planner preserves that rule.

The intended workflow is:

```text
Mastercam operations and their backplot times
                  |
             C# sync planner
                  |
     Sync marker instructions for the add-in/post
                  |
             Posted H and V text
                  |
    Your existing marker replacement script
                  |
          Final machine programs
```

## What the algorithm does

1. Read the operation information and time. For example, `FAM_2H 12002 := 00:35` means horizontal, offset 1, rotation digit 2, tool 002, and 35 seconds from Mastercam. This is operation metadata, not an NC instruction.
2. Keep the original H order and V order. Start a new H section whenever its tool or rotation changes. V may cut only after that section's B sequence is complete.
3. Try the different ways to divide the ordered V operations among those H sections. For each division, estimate how long both channels take, including waits and tool changes.
4. Choose the division with the shortest estimated cycle and return the required marker instructions.

For example, if H has 60 seconds in a section and its first 10 seconds are the B/tool-change sequence, V has a 50-second interval after B is ready. V cutting that fits in that interval adds no H delay. Work that runs past it makes H wait before the next B event. The actual calculation also accounts for V tool-change time and the configured margin.

The current defaults match `tools/sync_plan.py`: add 6 seconds per operation, 4 seconds of V lockout for a rotation-only event, 10 seconds for an H tool-change event, and 8 seconds for a V tool change. Input operation times already include their tool changes, so the planner redistributes that time rather than adding it twice. These are editable estimates, not measured machine constants. The port also preserves the Python planner's current tie choices; equal-cycle solutions may put V work in a later section.

## Files

- `SyncPlanner.cs`: the portable C# planning library. It has no Mastercam SDK references and does not write NC files or modify the open Mastercam job.
- `VerifyPlanner.cs`: a console verification program for hand-worked examples, input checks and the repository's reference jobs.
- `Build-And-Verify.ps1`: compiles both with the installed .NET Framework C# compiler and runs the verification program. Generated files go in the ignored `bin` directory.
- `verify_parity.py`: compares the C# marked operation list and cycle summary with the Python planner on all nine existing reference inputs. It does not rewrite the fixtures.

Run from PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\mastercam\Build-And-Verify.ps1
python .\mastercam\verify_parity.py
```

## Calling it from an add-in

Give each input the **real Mastercam operation ID**, represented as a string, and the formatted operation information including its time. Do not match outputs back to operations by a possibly repeated name.

```csharp
var inputs = new List<OperationInput>();
inputs.Add(new OperationInput("actual-H-operation-id", "FAM_2H 12002 := 00:35"));
inputs.Add(new OperationInput("actual-V-operation-id", "FAM_2V 11011 := 00:20"));

PlannerResult result = SyncPlanner.Plan(inputs, new PlannerSettings());

// result.Markers tells the host integration which operation and phase to mark.
// result.EstimatedCycleSeconds is the estimate for this ordered plan.
```

Use the `SpindleSync.Mastercam` namespace. The IDs above are illustrative; the host adapter supplies actual IDs and extracts the operation times using the API for the installed Mastercam version.

## Where each marker must appear in posted code

| Marker | Channel | Required position |
|---|---|---|
| `(WAIT BEFORE)` | H | Before the B/tool-change sequence, once V is clear |
| `(WAIT AFTER)` | H | After B has returned to its cutting position, **before H cutting starts** |
| `(WAIT)` | V | After V's tool change, **before its B-position calculation, G68 setup or B-dependent motion** |

Each B event has a matching H marker pair and one V marker. If an H section gets no V work, its V marker is attached to the next V operation. Several such markers can stack there in event order. If V has no operations remaining, those markers belong before the V program end.

The result contains semantic phase instructions rather than guessed Mastercam API calls. An H after-marker does **not** mean after the entire H machining operation: that would hold V while H cuts. Likewise, placing both H comments before an operation would release V before B moves. Your existing replacement script expands markers **in place**, so the Mastercam adapter and post must emit the comments at these required internal positions. The replacement script will not relocate them.

`RenderMarkedOperationList()` is a planning/reporting format matching the Python output. Its two H marker lines appear together before an operation's description. **That report is not posted NC and must not be pasted into a program as if those were final marker positions.** Use `Markers` and their `Phase` values for integration.

## Integration still needed

This is the planning part, not a loadable Mastercam add-in. Connecting it requires the Mastercam version, its matching .NET/NetHook project and SDK references, and the supported way to output comments at the specified post phases. Marker replacement is confirmed to happen in place. No host methods, marker-operation types or SDK entry points have been invented here.
