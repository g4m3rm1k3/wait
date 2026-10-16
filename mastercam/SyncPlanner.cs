// Portable planning core. Requires only the .NET Base Class Library (C# 5).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace SpindleSync.Mastercam
{
    /// <summary>Times are seconds. Backplot times already include tool changes.</summary>
    public sealed class PlannerSettings
    {
        public double SafetySeconds = 6;
        public double RotationLockoutSeconds = 4;
        public double ToolChangeLockoutSeconds = 10;
        public double VerticalToolChangeSeconds = 8;
        public bool StartIsBEvent = true;
    }

    /// <summary>
    /// One operation's stable Mastercam identifier and formatted metadata line,
    /// for example "FAM_2H 12002 :=00:35". This is operation metadata, not posted NC.
    /// </summary>
    public sealed class OperationInput
    {
        public OperationInput(string id, string formattedLine)
        {
            Id = id;
            FormattedLine = formattedLine;
        }

        public string Id { get; private set; }
        public string FormattedLine { get; private set; }
    }

    /// <summary>A parsed operation. Seconds includes SafetySeconds; BackplotSeconds does not.</summary>
    public sealed class PlannedOperation
    {
        public string Id { get; internal set; }
        public string OriginalLine { get; internal set; }
        public string Channel { get; internal set; }
        public int Offset { get; internal set; }
        public int Rotation { get; internal set; }
        public int Tool { get; internal set; }
        public double BackplotSeconds { get; internal set; }
        public double Seconds { get; internal set; }
    }

    /// <summary>
    /// Consecutive H operations sharing one tool and B position, with an ordered
    /// group of V operations assigned to run after its B lockout. StartSeconds
    /// and VerticalStartSeconds are absolute elapsed cycle times.
    /// </summary>
    public sealed class HorizontalStretch
    {
        public HorizontalStretch()
        {
            HorizontalOperations = new List<PlannedOperation>();
            VerticalOperations = new List<PlannedOperation>();
        }

        public List<PlannedOperation> HorizontalOperations { get; private set; }
        public List<PlannedOperation> VerticalOperations { get; private set; }
        public bool HasBEvent { get; internal set; }
        public double LockoutSeconds { get; internal set; }
        public double HorizontalSeconds { get; internal set; }
        public double StartSeconds { get; internal set; }
        public double VerticalStartSeconds { get; internal set; }
        public double DurationSeconds { get; internal set; }
        /// <summary>One-based B event number, or zero when this stretch has no B event.</summary>
        public int EventNumber { get; internal set; }
    }

    /// <summary>
    /// Semantic insertion phases for an SDK/post adapter. These directives must
    /// be resolved to actual posted setup/cutting phases; an operation-list row
    /// alone cannot identify a safe machine-code insertion point.
    /// </summary>
    public enum SyncMarkerPhase
    {
        BeforeHorizontalBSequence,
        AfterHorizontalBSequenceBeforeCut,
        AfterVerticalToolChangeBeforeBRead,
        BeforeVerticalProgramEnd
    }

    /// <summary>
    /// A synchronization directive, not a machine-ready wait code. Both H
    /// markers refer to the first H operation in the stretch: "WAIT AFTER"
    /// belongs after all B/T setup and before cutting, never after the entire
    /// operation. V waits belong after tool change and before reading B/G68.
    /// </summary>
    public sealed class SyncMarker
    {
        public int EventNumber { get; internal set; }
        public string Channel { get; internal set; }
        /// <summary>Target operation ID, or null for a V program-end directive.</summary>
        public string OperationId { get; internal set; }
        public string Text { get; internal set; }
        public SyncMarkerPhase Phase { get; internal set; }
    }

    /// <summary>Ordered operations, timing estimates, and semantic marker directives.</summary>
    public sealed class PlannerResult
    {
        public PlannerResult()
        {
            Stretches = new List<HorizontalStretch>();
            Markers = new List<SyncMarker>();
        }

        public List<HorizontalStretch> Stretches { get; private set; }
        public List<SyncMarker> Markers { get; private set; }
        public double EstimatedCycleSeconds { get; internal set; }

        /// <summary>
        /// Render the Python-compatible marked operation list: H rows followed
        /// by V rows and the cycle summary, using LF line endings. It is a
        /// planning report, not posted NC. Consult Markers for insertion phases.
        /// </summary>
        public string RenderMarkedOperationList()
        {
            List<string> hLines = new List<string>();
            List<string> vLines = new List<string>();
            double hTotal = 0;
            double vTotal = 0;
            foreach (HorizontalStretch stretch in Stretches)
            {
                if (stretch.HasBEvent)
                {
                    hLines.Add("(WAIT BEFORE)");
                    hLines.Add("(WAIT AFTER)");
                    vLines.Add("(WAIT)");
                }
                foreach (PlannedOperation op in stretch.HorizontalOperations)
                {
                    hLines.Add(op.OriginalLine);
                    hTotal += op.Seconds;
                }
                foreach (PlannedOperation op in stretch.VerticalOperations)
                {
                    vLines.Add(op.OriginalLine);
                    vTotal += op.Seconds;
                }
            }
            hLines.AddRange(vLines);
            hLines.Add("(EST CYCLE " + OneDecimal(EstimatedCycleSeconds) + "S  H IDLE "
                + OneDecimal(EstimatedCycleSeconds - hTotal) + "S  V IDLE "
                + OneDecimal(EstimatedCycleSeconds - vTotal) + "S)");
            return string.Join("\n", hLines.ToArray()) + "\n";
        }

        private static string OneDecimal(double value)
        {
            return Math.Round(value, 1, MidpointRounding.ToEven).ToString("F1", CultureInfo.InvariantCulture);
        }
    }

    /// <summary>
    /// Portable operation-list planner matching tools/sync_plan.py. Each spindle
    /// retains its input order. H tool changes include the complete B-to-safe,
    /// tool-change, B-return sequence; V is blocked throughout that lockout.
    /// No Mastercam SDK types or posted machine-code assumptions are required.
    /// </summary>
    public static class SyncPlanner
    {
        // Offset and rotation are one digit each; tool is exactly three digits.
        // As in Python, a seconds field >= 60 is accepted and added to minutes.
        private static readonly Regex OperationLine = new Regex(
            @"^\s*(\S+?)_2([HV])\s+(\d)(\d)(\d{3})\s*:=\s*(\d+):(\d+(?:\.\d+)?)\s*$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>
        /// Plan formatted operation metadata, assigning V operations to H
        /// stretches with the same strict-less-than dynamic-programming tie
        /// behavior as Python. IDs must be unique and nonempty. At least one H
        /// operation is required; an empty V program is supported.
        /// </summary>
        /// <exception cref="ArgumentException">Invalid input metadata, IDs, settings, or nonfinite time.</exception>
        public static PlannerResult Plan(IEnumerable<OperationInput> inputs, PlannerSettings settings = null)
        {
            if (inputs == null) throw new ArgumentNullException("inputs");
            if (settings == null) settings = new PlannerSettings();
            ValidateSettings(settings);

            List<PlannedOperation> horizontal = new List<PlannedOperation>();
            List<PlannedOperation> vertical = new List<PlannedOperation>();
            ParseOperations(inputs, settings, horizontal, vertical);
            if (horizontal.Count == 0) throw new ArgumentException("No H operations found; at least one horizontal operation is required.", "inputs");

            PlannerResult result = new PlannerResult();
            BuildStretches(horizontal, settings, result.Stretches);
            double pre;
            double[] pieces = VerticalPieces(vertical, settings, out pre);
            result.EstimatedCycleSeconds = AssignVertical(result.Stretches, vertical, pieces, pre);
            SetStretchTimes(result.Stretches, pieces, pre);
            BuildMarkers(result);
            return result;
        }

        private static void ValidateSettings(PlannerSettings settings)
        {
            CheckSetting(settings.SafetySeconds, "SafetySeconds");
            CheckSetting(settings.RotationLockoutSeconds, "RotationLockoutSeconds");
            CheckSetting(settings.ToolChangeLockoutSeconds, "ToolChangeLockoutSeconds");
            CheckSetting(settings.VerticalToolChangeSeconds, "VerticalToolChangeSeconds");
        }

        private static void CheckSetting(double value, string name)
        {
            if (!IsFinite(value) || value < 0)
                throw new ArgumentException(name + " must be finite and nonnegative.", "settings");
        }

        private static void ParseOperations(IEnumerable<OperationInput> inputs, PlannerSettings settings,
            List<PlannedOperation> horizontal, List<PlannedOperation> vertical)
        {
            HashSet<string> ids = new HashSet<string>(StringComparer.Ordinal);
            List<string> errors = new List<string>();
            int number = 0;
            foreach (OperationInput input in inputs)
            {
                number++;
                string location = "Line " + number.ToString(CultureInfo.InvariantCulture);
                if (input == null)
                {
                    errors.Add(location + ": operation input is null.");
                    continue;
                }
                if (string.IsNullOrWhiteSpace(input.Id))
                {
                    errors.Add(location + ": operation ID must be nonempty.");
                    continue;
                }
                location += " (operation " + input.Id + ")";
                if (!ids.Add(input.Id))
                {
                    errors.Add(location + ": duplicate operation ID.");
                    continue;
                }
                string raw = input.FormattedLine;
                Match match = raw == null ? Match.Empty : OperationLine.Match(raw);
                if (!match.Success)
                {
                    errors.Add(location + " not recognized: " + (raw ?? "<null>")
                        + ". Expected NAME_2H 12002 :=00:35 (or _2V).");
                    continue;
                }

                double minutes;
                double seconds;
                int offset;
                int rotation;
                int tool;
                if (!double.TryParse(match.Groups[6].Value, NumberStyles.None, CultureInfo.InvariantCulture, out minutes)
                    || !double.TryParse(match.Groups[7].Value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out seconds)
                    || !int.TryParse(match.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out offset)
                    || !int.TryParse(match.Groups[4].Value, NumberStyles.None, CultureInfo.InvariantCulture, out rotation)
                    || !int.TryParse(match.Groups[5].Value, NumberStyles.None, CultureInfo.InvariantCulture, out tool))
                {
                    errors.Add(location + ": numeric metadata could not be read as finite invariant-culture numbers.");
                    continue;
                }
                double backplot = minutes * 60 + seconds;
                double padded = backplot + settings.SafetySeconds;
                if (!IsFinite(backplot) || !IsFinite(padded) || backplot < 0)
                {
                    errors.Add(location + ": backplot time plus safety must be finite and nonnegative.");
                    continue;
                }
                PlannedOperation op = new PlannedOperation
                {
                    Id = input.Id,
                    OriginalLine = raw.Trim(),
                    Channel = match.Groups[2].Value.ToUpperInvariant(),
                    Offset = offset,
                    Rotation = rotation,
                    Tool = tool,
                    BackplotSeconds = backplot,
                    Seconds = padded
                };
                if (op.Channel == "H") horizontal.Add(op);
                else vertical.Add(op);
            }
            if (errors.Count != 0) throw new ArgumentException(string.Join("\n", errors.ToArray()), "inputs");
        }

        private static void BuildStretches(List<PlannedOperation> horizontal, PlannerSettings settings,
            List<HorizontalStretch> stretches)
        {
            PlannedOperation previous = null;
            int eventNumber = 0;
            foreach (PlannedOperation op in horizontal)
            {
                bool hasEvent;
                double lockout;
                if (previous == null)
                {
                    hasEvent = settings.StartIsBEvent;
                    lockout = hasEvent ? settings.ToolChangeLockoutSeconds : 0;
                }
                else if (previous.Tool != op.Tool)
                {
                    hasEvent = true;
                    lockout = settings.ToolChangeLockoutSeconds;
                }
                else if (previous.Rotation != op.Rotation)
                {
                    hasEvent = true;
                    lockout = settings.RotationLockoutSeconds;
                }
                else
                {
                    hasEvent = false;
                    lockout = 0;
                }

                if (stretches.Count == 0 || hasEvent)
                {
                    if (hasEvent) eventNumber++;
                    stretches.Add(new HorizontalStretch
                    {
                        HasBEvent = hasEvent,
                        LockoutSeconds = lockout,
                        EventNumber = hasEvent ? eventNumber : 0
                    });
                }
                HorizontalStretch stretch = stretches[stretches.Count - 1];
                stretch.HorizontalOperations.Add(op);
                stretch.HorizontalSeconds = FiniteSum(stretch.HorizontalSeconds, op.Seconds, "Horizontal stretch time");
                previous = op;
            }
        }

        private static double VerticalToolChange(List<PlannedOperation> vertical, int index, PlannerSettings settings)
        {
            if (index > 0 && vertical[index].Tool == vertical[index - 1].Tool) return 0;
            return Math.Min(settings.VerticalToolChangeSeconds, vertical[index].Seconds);
        }

        private static double[] VerticalPieces(List<PlannedOperation> vertical, PlannerSettings settings, out double pre)
        {
            double[] changes = new double[vertical.Count];
            for (int i = 0; i < changes.Length; i++) changes[i] = VerticalToolChange(vertical, i, settings);
            pre = vertical.Count > 0 ? changes[0] : 0;
            double[] pieces = new double[vertical.Count];
            for (int i = 0; i < pieces.Length; i++)
                pieces[i] = FiniteSum(vertical[i].Seconds - changes[i], i + 1 < changes.Length ? changes[i + 1] : 0,
                    "Vertical piece time at operation " + vertical[i].Id);
            return pieces;
        }

        private static void StretchTiming(int index, HorizontalStretch stretch, double work, double pre,
            out double verticalStart, out double cost)
        {
            if (index == 0 && !stretch.HasBEvent)
            {
                verticalStart = pre;
                cost = Math.Max(stretch.HorizontalSeconds, FiniteSum(pre, work, "Initial vertical time"));
                return;
            }
            double lead = index == 0 ? pre : 0;
            verticalStart = FiniteSum(lead, stretch.LockoutSeconds, "Vertical start time");
            cost = FiniteSum(lead, Math.Max(stretch.HorizontalSeconds,
                FiniteSum(stretch.LockoutSeconds, work, "Stretch lockout and vertical time")), "Stretch duration");
        }

        private static double AssignVertical(List<HorizontalStretch> stretches, List<PlannedOperation> vertical,
            double[] pieces, double pre)
        {
            int stretchCount = stretches.Count;
            int count = vertical.Count;
            double[] prefix = new double[count + 1];
            for (int i = 0; i < count; i++) prefix[i + 1] = FiniteSum(prefix[i], pieces[i], "Vertical total time");
            double[,] best = new double[stretchCount + 1, count + 1];
            int[,] start = new int[stretchCount + 1, count + 1];
            for (int s = 0; s <= stretchCount; s++)
                for (int j = 0; j <= count; j++) best[s, j] = double.PositiveInfinity;
            best[0, 0] = 0;

            // Loop order and strict '<' intentionally match Python, including ties.
            for (int s = 1; s <= stretchCount; s++)
            {
                for (int j = 0; j <= count; j++)
                {
                    for (int i = 0; i <= j; i++)
                    {
                        if (double.IsPositiveInfinity(best[s - 1, i])) continue;
                        double verticalStart;
                        double cost;
                        StretchTiming(s - 1, stretches[s - 1], prefix[j] - prefix[i], pre, out verticalStart, out cost);
                        double candidate = FiniteSum(best[s - 1, i], cost, "Estimated cycle time");
                        if (candidate < best[s, j])
                        {
                            best[s, j] = candidate;
                            start[s, j] = i;
                        }
                    }
                }
            }
            int end = count;
            for (int s = stretchCount; s > 0; s--)
            {
                int first = start[s, end];
                for (int i = first; i < end; i++) stretches[s - 1].VerticalOperations.Add(vertical[i]);
                end = first;
            }
            return best[stretchCount, count];
        }

        private static void SetStretchTimes(List<HorizontalStretch> stretches, double[] pieces, double pre)
        {
            double elapsed = 0;
            int firstVertical = 0;
            for (int index = 0; index < stretches.Count; index++)
            {
                HorizontalStretch stretch = stretches[index];
                double work = 0;
                for (int i = 0; i < stretch.VerticalOperations.Count; i++) work += pieces[firstVertical + i];
                double relativeStart;
                double duration;
                StretchTiming(index, stretch, work, pre, out relativeStart, out duration);
                stretch.StartSeconds = elapsed;
                stretch.VerticalStartSeconds = FiniteSum(elapsed, relativeStart, "Absolute vertical start time");
                stretch.DurationSeconds = duration;
                elapsed = FiniteSum(elapsed, duration, "Elapsed cycle time");
                firstVertical += stretch.VerticalOperations.Count;
            }
        }

        private static void BuildMarkers(PlannerResult result)
        {
            for (int index = 0; index < result.Stretches.Count; index++)
            {
                HorizontalStretch stretch = result.Stretches[index];
                if (!stretch.HasBEvent) continue;
                string horizontalId = stretch.HorizontalOperations[0].Id;
                result.Markers.Add(new SyncMarker
                {
                    EventNumber = stretch.EventNumber, Channel = "H", OperationId = horizontalId,
                    Text = "(WAIT BEFORE)", Phase = SyncMarkerPhase.BeforeHorizontalBSequence
                });
                result.Markers.Add(new SyncMarker
                {
                    EventNumber = stretch.EventNumber, Channel = "H", OperationId = horizontalId,
                    Text = "(WAIT AFTER)", Phase = SyncMarkerPhase.AfterHorizontalBSequenceBeforeCut
                });

                // Empty V groups still acknowledge every B event. Anchor stacked
                // waits at the next V operation, or at program end when none remain.
                string verticalId = null;
                for (int next = index; next < result.Stretches.Count; next++)
                {
                    if (result.Stretches[next].VerticalOperations.Count == 0) continue;
                    verticalId = result.Stretches[next].VerticalOperations[0].Id;
                    break;
                }
                result.Markers.Add(new SyncMarker
                {
                    EventNumber = stretch.EventNumber, Channel = "V", OperationId = verticalId,
                    Text = "(WAIT)", Phase = verticalId == null ? SyncMarkerPhase.BeforeVerticalProgramEnd
                        : SyncMarkerPhase.AfterVerticalToolChangeBeforeBRead
                });
            }
        }

        private static bool IsFinite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        private static double FiniteSum(double left, double right, string description)
        {
            double value = left + right;
            if (!IsFinite(value)) throw new ArgumentException(description + " exceeds the finite supported range.", "inputs");
            return value;
        }
    }
}
