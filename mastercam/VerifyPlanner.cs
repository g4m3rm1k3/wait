// Standalone verification runner. No Mastercam assemblies are required.
// Compile together with SyncPlanner.cs using the .NET C# 5 compiler.
// Usage: VerifyPlanner.exe [repository-root] [--parity]
// --parity prints PARITY|case-name|base64(UTF-8 marked operation list).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace SpindleSync.Mastercam
{
    internal static class VerifyPlanner
    {
        private static int passed;
        private static int failed;

        public static int Main(string[] args)
        {
            string root = null;
            bool parity = false;
            foreach (string argument in args)
            {
                if (argument == "--parity") parity = true;
                else if (root == null && !argument.StartsWith("--", StringComparison.Ordinal)) root = Path.GetFullPath(argument);
                else
                {
                    Console.Error.WriteLine("Usage: VerifyPlanner.exe [repository-root] [--parity]");
                    return 2;
                }
            }
            if (root == null) root = FindRepositoryRoot();

            Run("manual example gives 98 seconds", delegate
            {
                var result = SyncPlanner.Plan(new[] {
                    Input("h1", "FAM_2H 11001 := 00:54"),
                    Input("v1", "FAM_2V 11010 := 00:14"),
                    Input("v2", "FAM_2V 11011 := 00:24"),
                    Input("h2", "FAM_2H 11002 := 00:24"),
                    Input("v3", "FAM_2V 11012 := 00:04")
                });
                Near(result.EstimatedCycleSeconds, 98, "cycle");
                Sequence(result.Stretches.SelectMany(s => s.HorizontalOperations).Select(o => o.Id), new[] { "h1", "h2" }, "H order");
                Sequence(result.Stretches.SelectMany(s => s.VerticalOperations).Select(o => o.Id), new[] { "v1", "v2", "v3" }, "V order");
                Sequence(result.Stretches.Select(s => s.VerticalOperations.Count().ToString(CultureInfo.InvariantCulture)), new[] { "2", "1" }, "V grouping");
            });

            Run("existing 128 second tie puts V in the later stretch", delegate
            {
                var result = SyncPlanner.Plan(new[] {
                    Input("h1", "FAM_2H 11001 := 00:54"),
                    Input("h2", "FAM_2H 11002 := 00:54"),
                    Input("v1", "FAM_2V 11010 := 00:04")
                });
                Near(result.EstimatedCycleSeconds, 128, "cycle");
                Sequence(result.Stretches.Select(s => s.VerticalOperations.Count().ToString(CultureInfo.InvariantCulture)), new[] { "0", "1" }, "strict-less-than tie behavior");
                var verticalMarkers = result.Markers.Where(m => m.Channel == "V").OrderBy(m => m.EventNumber).ToArray();
                Check(verticalMarkers.Length == 2 && verticalMarkers.All(m => m.OperationId == "v1"), "empty first stretch stacks its V handshake on the next operation identity");
            });

            Run("whole H tool-change sequence remains a V lockout", delegate
            {
                var result = SyncPlanner.Plan(new[] {
                    Input("h1", "FAM_2H 11001 := 00:54"),
                    Input("h2", "FAM_2H 11002 := 00:54"),
                    Input("v1", "FAM_2V 11011 := 00:44"),
                    Input("v2", "FAM_2V 11012 := 00:38")
                });
                var settings = new PlannerSettings();
                Check(result.Stretches.Count() == 2, "tool change must create a second H stretch");
                foreach (var stretch in result.Stretches)
                {
                    Check(stretch.HasBEvent, "each tool-change stretch starts with a B event");
                    Near(stretch.LockoutSeconds, settings.ToolChangeLockoutSeconds, "whole tool-change lockout");
                    Check(stretch.VerticalStartSeconds + 1e-9 >= stretch.StartSeconds + stretch.LockoutSeconds, "V cannot cut before the complete H lockout expires");
                    var after = result.Markers.Single(m => m.Channel == "H" && m.EventNumber == stretch.EventNumber && m.Phase == SyncMarkerPhase.AfterHorizontalBSequenceBeforeCut);
                    Check(after.OperationId == stretch.HorizontalOperations.First().Id, "H release is attached to the setup phase of the event operation");
                }
            });

            Run("decimal seconds are invariant under comma-decimal culture", delegate
            {
                CultureInfo previous = Thread.CurrentThread.CurrentCulture;
                try
                {
                    Thread.CurrentThread.CurrentCulture = new CultureInfo("de-DE");
                    var result = SyncPlanner.Plan(new[] { Input("decimal", "FAM_2H 11001 := 01:00.5") });
                    var operation = result.Stretches.First().HorizontalOperations.First();
                    Near(operation.BackplotSeconds, 60.5, "decimal backplot seconds");
                    Near(operation.Seconds, 66.5, "safety is added once");
                }
                finally { Thread.CurrentThread.CurrentCulture = previous; }
            });

            Run("input interleaving preserves both channel orders", delegate
            {
                var result = SyncPlanner.Plan(new[] {
                    Input("v-first", "FAM_2V 11010 := 00:10"),
                    Input("h-first", "FAM_2H 11001 := 00:54"),
                    Input("v-second", "FAM_2V 11011 := 00:10"),
                    Input("h-second", "FAM_2H 12001 := 00:54")
                });
                Sequence(result.Stretches.SelectMany(s => s.HorizontalOperations).Select(o => o.Id), new[] { "h-first", "h-second" }, "H order");
                Sequence(result.Stretches.SelectMany(s => s.VerticalOperations).Select(o => o.Id), new[] { "v-first", "v-second" }, "V order");
            });

            Run("zero V operations still answer every B event at the footer", delegate
            {
                var result = SyncPlanner.Plan(new[] {
                    Input("h1", "FAM_2H 11001 := 00:54"),
                    Input("h2", "FAM_2H 11002 := 00:54"),
                    Input("h3", "FAM_2H 12002 := 00:54")
                });
                var waits = result.Markers.Where(m => m.Channel == "V").OrderBy(m => m.EventNumber).ToArray();
                Check(waits.Length == 3, "one V handshake for each H B event");
                Check(waits.All(m => m.OperationId == null && m.Phase == SyncMarkerPhase.BeforeVerticalProgramEnd && m.Text == "(WAIT)"), "V handshakes have explicit footer anchors");
                Sequence(waits.Select(m => m.EventNumber.ToString(CultureInfo.InvariantCulture)), new[] { "1", "2", "3" }, "stacked event order");
            });

            Run("repeated operation titles keep distinct stable identities", delegate
            {
                const string repeated = "FAM_2H 11001 := 00:30";
                var result = SyncPlanner.Plan(new[] { Input("operation-A", repeated), Input("operation-B", repeated) });
                var operations = result.Stretches.SelectMany(s => s.HorizontalOperations).ToArray();
                Sequence(operations.Select(o => o.Id), new[] { "operation-A", "operation-B" }, "distinct identities");
                Check(operations.All(o => o.OriginalLine == repeated), "original repeated names remain intact");
                Check(result.Markers.Where(m => m.Channel == "H").All(m => m.OperationId == "operation-A"), "markers anchor to identity rather than an ambiguous title");
            });

            Run("B already in position omits the first handshake", delegate
            {
                var settings = new PlannerSettings { StartIsBEvent = false };
                var result = SyncPlanner.Plan(new[] {
                    Input("h", "FAM_2H 11001 := 00:54"),
                    Input("v", "FAM_2V 11010 := 00:04")
                }, settings);
                Check(!result.Stretches.First().HasBEvent, "initial stretch has no B event");
                Check(!result.Markers.Any(), "no manufactured wait when B starts in position");
                Near(result.EstimatedCycleSeconds, 60, "concurrent first stretch");
            });

            Run("invalid format and missing H operations fail", delegate
            {
                Throws(delegate { SyncPlanner.Plan(new[] { Input("bad", "not an operation") }); }, "invalid operation format");
                Throws(delegate { SyncPlanner.Plan(new[] { Input("v-only", "FAM_2V 11010 := 00:04") }); }, "missing H operations");
            });

            Run("duplicate operation IDs fail instead of producing ambiguous anchors", delegate
            {
                Throws(delegate {
                    SyncPlanner.Plan(new[] { Input("same", "FAM_2H 11001 := 00:54"), Input("same", "FAM_2V 11010 := 00:04") });
                }, "duplicate IDs across channels");
            });

            Run("invalid timing settings fail", delegate
            {
                Throws(delegate { SyncPlanner.Plan(new[] { Input("h", "FAM_2H 11001 := 00:54") }, new PlannerSettings { SafetySeconds = -1 }); }, "negative safety");
                Throws(delegate { SyncPlanner.Plan(new[] { Input("h", "FAM_2H 11001 := 00:54") }, new PlannerSettings { ToolChangeLockoutSeconds = Double.NaN }); }, "non-finite lockout");
            });

            if (root == null)
            {
                failed++;
                Console.Error.WriteLine("FAIL conformance inputs: provide the repository root containing tools/conformance/cases.");
            }
            else
            {
                string cases = Path.Combine(root, "tools", "conformance", "cases");
                string[] directories = Directory.Exists(cases) ? Directory.GetDirectories(cases) : new string[0];
                Array.Sort(directories, StringComparer.Ordinal);
                if (directories.Length != 9)
                {
                    failed++;
                    Console.Error.WriteLine("FAIL conformance inputs: expected 9 case directories, found " + directories.Length.ToString(CultureInfo.InvariantCulture));
                }
                foreach (string directory in directories)
                {
                    string path = directory;
                    Run("reference " + Path.GetFileName(path), delegate { VerifyReferenceCase(path, parity); });
                }
            }
            Console.WriteLine("Planner verification: " + passed.ToString(CultureInfo.InvariantCulture) + " passed, " + failed.ToString(CultureInfo.InvariantCulture) + " failed.");
            return failed == 0 ? 0 : 1;
        }

        private static void VerifyReferenceCase(string directory, bool parity)
        {
            string[] lines = File.ReadAllLines(Path.Combine(directory, "ops.txt"));
            var input = new List<OperationInput>();
            for (int i = 0; i < lines.Length; i++)
                if (!String.IsNullOrWhiteSpace(lines[i])) input.Add(Input("line:" + (i + 1).ToString(CultureInfo.InvariantCulture), lines[i]));
            string report = File.ReadAllText(Path.Combine(directory, "expected", "report.txt"));
            var settings = SettingsFromReport(report);
            var result = SyncPlanner.Plan(input, settings);

            // Build reference channel identity lists from the actual source line
            // numbers; names are intentionally not used as identifiers.
            var hIds = new List<string>();
            var vIds = new List<string>();
            for (int i = 0; i < lines.Length; i++)
            {
                if (String.IsNullOrWhiteSpace(lines[i])) continue;
                string id = "line:" + (i + 1).ToString(CultureInfo.InvariantCulture);
                if (Regex.IsMatch(lines[i], "_2H\\s", RegexOptions.IgnoreCase)) hIds.Add(id);
                else if (Regex.IsMatch(lines[i], "_2V\\s", RegexOptions.IgnoreCase)) vIds.Add(id);
            }
            Sequence(result.Stretches.SelectMany(s => s.HorizontalOperations).Select(o => o.Id), hIds, "reference H order");
            Sequence(result.Stretches.SelectMany(s => s.VerticalOperations).Select(o => o.Id), vIds, "reference V order");
            Check(!Double.IsNaN(result.EstimatedCycleSeconds) && !Double.IsInfinity(result.EstimatedCycleSeconds), "finite cycle duration");

            var stretches = result.Stretches.ToArray();
            int eventNumber = 0;
            for (int s = 0; s < stretches.Length; s++)
            {
                if (!stretches[s].HasBEvent) continue;
                eventNumber++;
                Check(stretches[s].EventNumber == eventNumber, "event numbers are contiguous");
                string hId = stretches[s].HorizontalOperations.First().Id;
                var markers = result.Markers.Where(m => m.EventNumber == eventNumber).ToArray();
                Check(markers.Length == 3, "one H pair and one V handshake per event");
                Check(markers.Count(m => m.Channel == "H" && m.OperationId == hId && m.Text == "(WAIT BEFORE)" && m.Phase == SyncMarkerPhase.BeforeHorizontalBSequence) == 1, "H before marker phase and identity");
                Check(markers.Count(m => m.Channel == "H" && m.OperationId == hId && m.Text == "(WAIT AFTER)" && m.Phase == SyncMarkerPhase.AfterHorizontalBSequenceBeforeCut) == 1, "H after marker phase and identity");
                string nextVId = stretches.Skip(s).SelectMany(stretch => stretch.VerticalOperations).Select(o => o.Id).FirstOrDefault();
                var vMarker = markers.Single(m => m.Channel == "V");
                Check(vMarker.OperationId == nextVId, "V marker is attached to the next real operation or channel footer");
                Check(vMarker.Phase == (nextVId == null ? SyncMarkerPhase.BeforeVerticalProgramEnd : SyncMarkerPhase.AfterVerticalToolChangeBeforeBRead), "V marker phase");
            }
            Check(result.Markers.Count() == eventNumber * 3, "no additional markers");

            Match end = Regex.Match(report, @"^\s*(\d+)s end of cycle", RegexOptions.Multiline);
            if (end.Success)
            {
                double expected = Double.Parse(end.Groups[1].Value, CultureInfo.InvariantCulture);
                Near(Math.Round(result.EstimatedCycleSeconds, 0, MidpointRounding.ToEven), expected, "reference rounded cycle");
            }
            string hMarked = Path.Combine(directory, "expected", "H_marked.nc");
            string vMarked = Path.Combine(directory, "expected", "V_marked.nc");
            if (File.Exists(hMarked) && File.Exists(vMarked))
            {
                int hBefore = File.ReadAllLines(hMarked).Count(line => line.Trim() == "(WAIT BEFORE)");
                int hAfter = File.ReadAllLines(hMarked).Count(line => line.Trim() == "(WAIT AFTER)");
                int vWait = File.ReadAllLines(vMarked).Count(line => line.Trim() == "(WAIT)");
                Check(hBefore == eventNumber && hAfter == eventNumber && vWait == eventNumber, "reference NC marker counts");
            }
            // Cases 07 and 08 deliberately fail NC inspection, not operation
            // planning. Their operation lists must still produce a valid plan.
            if (parity) Console.WriteLine("PARITY|" + Path.GetFileName(directory) + "|" + Convert.ToBase64String(Encoding.UTF8.GetBytes(result.RenderMarkedOperationList())));
        }

        private static PlannerSettings SettingsFromReport(string report)
        {
            var settings = new PlannerSettings();
            foreach (string line in report.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                Match match = Regex.Match(line, @"^sync_plan\.([A-Z_]+) = (.+)$");
                if (!match.Success) continue;
                string key = match.Groups[1].Value;
                string value = match.Groups[2].Value;
                if (key == "START_IS_B_EVENT") { settings.StartIsBEvent = Boolean.Parse(value); continue; }
                double seconds = Double.Parse(value, NumberStyles.Float, CultureInfo.InvariantCulture);
                switch (key)
                {
                    case "SAFETY_SECONDS": settings.SafetySeconds = seconds; break;
                    case "ROTATE_LOCKOUT_SECONDS": settings.RotationLockoutSeconds = seconds; break;
                    case "TOOL_CHANGE_LOCKOUT_SECONDS": settings.ToolChangeLockoutSeconds = seconds; break;
                    case "V_TOOL_CHANGE_SECONDS": settings.VerticalToolChangeSeconds = seconds; break;
                    default: throw new InvalidOperationException("Unknown reference setting " + key);
                }
            }
            return settings;
        }

        private static OperationInput Input(string id, string formattedLine) { return new OperationInput(id, formattedLine); }

        private static void Run(string name, Action test)
        {
            try { test(); passed++; Console.WriteLine("PASS " + name); }
            catch (Exception exception) { failed++; Console.Error.WriteLine("FAIL " + name + ": " + exception.Message); }
        }

        private static void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private static void Near(double actual, double expected, string message)
        {
            Check(Math.Abs(actual - expected) <= 1e-8, message + ": expected " + expected.ToString("R", CultureInfo.InvariantCulture) + ", got " + actual.ToString("R", CultureInfo.InvariantCulture));
        }

        private static void Sequence(IEnumerable<string> actual, IEnumerable<string> expected, string message)
        {
            string[] a = actual.ToArray();
            string[] e = expected.ToArray();
            Check(a.SequenceEqual(e), message + ": expected [" + String.Join(", ", e) + "], got [" + String.Join(", ", a) + "]");
        }

        private static void Throws(Action action, string message)
        {
            bool thrown = false;
            try { action(); }
            catch (Exception) { thrown = true; }
            Check(thrown, message + " should reject the input");
        }

        private static string FindRepositoryRoot()
        {
            var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
            while (directory != null)
            {
                if (Directory.Exists(Path.Combine(directory.FullName, "tools", "conformance", "cases"))) return directory.FullName;
                directory = directory.Parent;
            }
            return null;
        }
    }
}
