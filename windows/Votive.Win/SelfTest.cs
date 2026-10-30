using System.Text.Json;

namespace Votive.Win;

/// <summary>`VotiveWin.exe --self-test`: checks the pure logic without a display. Exit code 0 = all passed.</summary>
static class SelfTest
{
    static int _failed;
    static void Check(bool ok, string name) { Console.WriteLine((ok ? "ok   " : "FAIL ") + name); if (!ok) _failed++; }

    public static int Run()
    {
        const long now = 1_800_000_000_000;
        Check(StateResolver.Resolve("working", now - 1000, now, true) == AgentState.Working, "working is working");
        Check(StateResolver.Resolve("working", now - 9 * 60_000, now, true) == AgentState.Stuck, "working with no news for 9 min is stuck");
        Check(StateResolver.Resolve("working", now - 7 * 60_000, now, true) == AgentState.Working, "7 min is still working");
        Check(StateResolver.Resolve("working", now, now, false) == AgentState.Stopped, "a dead process is stopped");
        Check(StateResolver.Resolve("done", now, now, false) == AgentState.Stopped, "even a finished one whose process is gone");
        Check(StateResolver.Resolve("working", now, now, null) == AgentState.Working, "unknown liveness does not alarm");
        Check(StateResolver.Resolve("waiting", now, now, true) == AgentState.NeedsInput, "waiting needs you");
        Check(StateResolver.Resolve("error", now, now, true) == AgentState.Warning, "error is a warning");
        Check(StateResolver.Resolve("starting", now, now, true) == AgentState.Starting, "starting");
        Check(StateResolver.Resolve("nonsense", now, now, true) == AgentState.Done, "unknown event reads as done");
        Check(StateResolver.Resolve(null, 0, now, true) == AgentState.Done, "null event reads as done");
        Check(StateResolver.Resolve("working", 0, now, true, 0) == AgentState.Working, "a threshold of 0 turns stuck detection off");
        var order = new[] { AgentState.Done, AgentState.Working, AgentState.Stuck, AgentState.NeedsInput, AgentState.Stopped, AgentState.Warning, AgentState.Starting }
            .OrderBy(StateResolver.Priority).ToArray();
        Check(order.SequenceEqual(new[] { AgentState.NeedsInput, AgentState.Warning, AgentState.Stuck, AgentState.Stopped, AgentState.Working, AgentState.Starting, AgentState.Done }), "priority order matches macOS");

        SessionEntry? P(string json) { using var d = JsonDocument.Parse(json); return EventStore.Parse(d.RootElement); }
        var ok = P("{\"agent\":\"claude-code\",\"sessionId\":\"s1\",\"lastEvent\":\"working\",\"lastEventAt\":1800000000000,\"pid\":4242,\"cwd\":\"C:\\\\work\\\\my proj\\\\\"}");
        Check(ok != null && ok.Project == "my proj" && ok.Pid == 4242 && ok.LastEvent == "working", "a real event file parses, project from cwd");
        Check(P("[]") == null && P("\"x\"") == null && P("{}") == null, "wrong shapes are skipped");
        Check(P("{\"agent\":\"a\",\"sessionId\":\"s\",\"lastEvent\":\"working\",\"lastEventAt\":-5}") == null, "negative time is skipped");
        Check(P("{\"agent\":\"a\",\"sessionId\":\"s\",\"lastEvent\":\"working\",\"lastEventAt\":99999999999999999}") == null, "absurd time is skipped");
        Check(P("{\"agent\":\"a\",\"sessionId\":\"s\",\"lastEvent\":\"working\",\"lastEventAt\":\"now\"}") == null, "string time is skipped");
        var strPid = P("{\"agent\":\"a\",\"sessionId\":\"s\",\"lastEvent\":\"done\",\"lastEventAt\":1,\"pid\":\"12\"}");
        Check(strPid != null && strPid.Pid == 0, "a string pid is ignored, the entry still loads");
        var big = P("{\"agent\":\"" + new string('x', 500) + "\",\"sessionId\":\"s\",\"lastEvent\":\"done\",\"lastEventAt\":1,\"cwd\":\"/a/b\\u0007c\"}");
        Check(big != null && big.Agent.Length == 40 && !big.Project.Any(char.IsControl), "long names are clipped, control characters removed");
        Check(EventStore.IsAlive(Environment.ProcessId) == true, "this process is alive");
        Check(EventStore.IsAlive(2_000_000_000) == false, "a pid nothing has is not alive");
        Check(EventStore.IsAlive(0) == null && EventStore.IsAlive(-3) == null, "no pid recorded means unknown");
        var missing = EventStore.Scan(Path.Combine(Path.GetTempPath(), "ao-no-such-dir-" + Guid.NewGuid().ToString("N")));
        Check(missing.Count == 0, "a missing folder is no sessions");


        // ---- placement (pure) ----
        var bounds = new Rectangle(0, 0, 1920, 1080); var work = new Rectangle(0, 0, 1920, 1032); var pill = new Size(100, 30);
        Point? Pl(PillMode m, TaskbarEdge e = TaskbarEdge.Bottom, Size? bar = null, int dpi = 96, Point? c = null) => Placement.Compute(m, bounds, work, pill, e, bar ?? new Size(1920, 48), dpi, c);
        Check(Pl(PillMode.Top) == new Point(910, 8), "top: centred under the top edge");
        Check(Pl(PillMode.Top, dpi: 192) == new Point(910, 16), "top: margins scale with DPI");
        Check(Pl(PillMode.Taskbar) == new Point(1804, 994), "taskbar: bottom corner by the tray, clear of a bottom taskbar");
        Check(Pl(PillMode.Taskbar, bar: new Size(1920, 2)) == new Point(1804, 994), "taskbar: an auto-hidden bar (2 px sliver) still gets a normal bar's room");
        Check(Pl(PillMode.Taskbar, TaskbarEdge.Top) == new Point(1804, 56), "taskbar on top: pill sits just below it");
        Check(Pl(PillMode.Taskbar, TaskbarEdge.Left, new Size(48, 1080)) == new Point(56, 1034), "taskbar on the left: pill sits right of it");
        Check(Pl(PillMode.Taskbar, TaskbarEdge.Right, new Size(48, 1080)) == new Point(1764, 1034), "taskbar on the right: pill sits left of it");
        Check(Pl(PillMode.TrayOnly) == null, "tray only: no pill");
        Check(Pl(PillMode.Custom, c: new Point(300, 200)) == new Point(300, 200), "custom: where it was put");
        Check(Pl(PillMode.Custom, c: new Point(5000, 5000)) == new Point(1820, 1050), "custom: pulled back on screen (monitor was unplugged)");
        Check(Pl(PillMode.Custom, c: new Point(-500, -500)) == new Point(0, 0), "custom: negative corner clamps");
        Check(Pl(PillMode.Custom) == new Point(910, 8), "custom with nothing saved falls back to top");
        Check(Placement.ParseMode("taskbar") == PillMode.Taskbar && Placement.ParseMode("tray") == PillMode.TrayOnly && Placement.ParseMode("custom") == PillMode.Custom, "mode names parse");
        Check(Placement.ParseMode(null) == PillMode.Top && Placement.ParseMode("BOTTOM; rm -rf") == PillMode.Top && Placement.ParseMode("") == PillMode.Top, "unknown modes read as top");
        Check(Enum.GetValues<PillMode>().All(m => Placement.ParseMode(Placement.ModeName(m)) == m), "every mode round-trips through its name");

        // ---- settings ----
        Check(SettingsStore.Parse("{\"pillPosition\":\"taskbar\",\"pillX\":10,\"pillY\":20}") == new AppSettings(PillMode.Taskbar, new Point(10, 20)), "settings parse");
        Check(SettingsStore.Parse("") == AppSettings.Default && SettingsStore.Parse("not json") == AppSettings.Default && SettingsStore.Parse("[]") == AppSettings.Default, "bad files give the default");
        Check(SettingsStore.Parse("{\"pillPosition\":5}").Mode == PillMode.Top, "a number where the mode should be is ignored");
        Check(SettingsStore.Parse("{\"pillX\":\"a\",\"pillY\":3}").Custom == null, "a string coordinate is ignored");
        Check(SettingsStore.Parse("{\"pillX\":99999999,\"pillY\":0}").Custom == null, "an absurd coordinate is ignored");
        Check(SettingsStore.Parse("{\"pillX\":5}").Custom == null, "one coordinate alone is not a position");
        var dir = Path.Combine(Path.GetTempPath(), "ao-settings-" + Guid.NewGuid().ToString("N")); var file = Path.Combine(dir, "sub", "settings.json");
        SettingsStore.Save(PillMode.Taskbar, null, file);
        Check(SettingsStore.Load(file) == new AppSettings(PillMode.Taskbar, null), "save then load, creating the folder");
        File.WriteAllText(file, "{\"shapesMode\":true,\"stuckThresholdMinutes\":15,\"pillPosition\":\"top\"}");
        SettingsStore.Save(PillMode.Custom, new Point(7, 9), file);
        var kept = File.ReadAllText(file);
        Check(kept.Contains("\"shapesMode\":true") && kept.Contains("\"stuckThresholdMinutes\":15"), "saving keeps the other keys (the Node settings tool shares the file)");
        var reread = SettingsStore.Load(file);
        Check(reread.Mode == PillMode.Custom && reread.Custom == new Point(7, 9) && reread.StuckMinutes == 15, "custom position saved and loaded, other keys still read");
        File.WriteAllText(file, "garbage");
        SettingsStore.Save(PillMode.TrayOnly, null, file);
        Check(SettingsStore.Load(file).Mode == PillMode.TrayOnly, "a corrupt file is replaced, not fatal");
        try { Directory.Delete(dir, true); } catch { }


        // ---- phase 2: time text, flyout position, extra fields ----
        Check(Format.Ago(1000, 1000) == "now" && Format.Ago(0, 4_000) == "now" && Format.Ago(10_000, 5_000) == "now", "ago: just now, and a future time is now");
        Check(Format.Ago(0, 45_000) == "45s" && Format.Ago(0, 180_000) == "3m" && Format.Ago(0, 7_300_000) == "2h" && Format.Ago(0, 5 * 86_400_000L) == "5d", "ago: seconds, minutes, hours, days");
        var fly = new Size(340, 200);
        Check(Placement.FlyoutAt(new Rectangle(910, 8, 100, 30), fly, bounds, 6) == new Point(790, 44), "flyout: opens below a pill in the top half, centred on it");
        Check(Placement.FlyoutAt(new Rectangle(1804, 994, 100, 30), fly, bounds, 6) == new Point(1574, 788), "flyout: opens above a pill in the bottom half, kept inside the right edge");
        Check(Placement.FlyoutAt(new Rectangle(0, 5, 40, 30), fly, bounds, 6) == new Point(6, 41), "flyout: kept inside the left edge");
        Check(Placement.FlyoutAt(new Rectangle(500, 500, 1, 1), new Size(5000, 5000), bounds, 6).X >= 0, "flyout: bigger than the screen does not throw");
        var withPrompt = P("{\"agent\":\"a\",\"sessionId\":\"s\",\"lastEvent\":\"waiting\",\"lastEventAt\":1,\"prompt\":\"fix the login bug\",\"waitReason\":\"Bash\"}");
        Check(withPrompt != null && withPrompt.Prompt == "fix the login bug" && withPrompt.Detail == "Bash", "prompt and wait reason are carried");
        var noPrompt = P("{\"agent\":\"a\",\"sessionId\":\"s\",\"lastEvent\":\"done\",\"lastEventAt\":1,\"prompt\":42,\"detail\":\"   \"}");
        Check(noPrompt != null && noPrompt.Prompt == null && noPrompt.Detail == null, "a non-string prompt and a blank detail are ignored");


        // ---- phase 4: usage ----
        long nowS = 1_800_000_000; long nowMsU = nowS * 1000;
        var u = UsageStore.Parse("{\"windows\":[{\"label\":\"Session\",\"usedPercentage\":42.7,\"resetsAt\":" + (nowS + 7300) + "},{\"label\":\"Weekly\",\"usedPercentage\":71,\"resetsAt\":" + (nowS + 3 * 86400 + 5 * 3600) + "}]}", nowMsU);
        Check(u.Count == 2 && u[0].Label == "Session" && u[0].Percent == 42 && u[0].ResetsInMs == 7_300_000 && u[1].Percent == 71, "usage parses, percent floors, reset is a countdown");
        Check(UsageStore.Parse("{\"windows\":[{\"label\":\"Session\",\"usedPercentage\":90,\"resetsAt\":" + (nowS - 10) + "}]}", nowMsU).Count == 0, "a window that already reset is dropped");
        Check(UsageStore.Parse("{\"windows\":[{\"label\":\"S\",\"usedPercentage\":101,\"resetsAt\":" + (nowS + 60) + "},{\"label\":\"S\",\"usedPercentage\":-1,\"resetsAt\":" + (nowS + 60) + "},{\"label\":\"S\",\"usedPercentage\":\"50\",\"resetsAt\":" + (nowS + 60) + "},{\"label\":5,\"usedPercentage\":5,\"resetsAt\":" + (nowS + 60) + "}]}", nowMsU).Count == 0, "out-of-range, string and mistyped values are ignored");
        Check(UsageStore.Parse("{\"windows\":[{\"label\":\"S\",\"usedPercentage\":5,\"resetsAt\":5}]}", nowMsU).Count == 0 && UsageStore.Parse("{\"windows\":[{\"label\":\"S\",\"usedPercentage\":5,\"resetsAt\":99999999999}]}", nowMsU).Count == 0, "implausible reset times are ignored");
        Check(UsageStore.Parse("[]", nowMsU).Count == 0 && UsageStore.Parse("not json", nowMsU).Count == 0 && UsageStore.Parse("{\"windows\":5}", nowMsU).Count == 0 && UsageStore.Parse("{}", nowMsU).Count == 0, "wrong shapes give nothing");
        var ctl = UsageStore.Parse("{\"windows\":[{\"label\":\"A\\u0007B" + new string('x', 60) + "\",\"usedPercentage\":1,\"resetsAt\":" + (nowS + 60) + "}]}", nowMsU);
        Check(ctl.Count == 1 && ctl[0].Label.Length == 24 && !ctl[0].Label.Any(char.IsControl), "labels are clipped and cleaned");
        Check(new UsageSummary(new List<UsageWindow> { new("a", 70, null) }).OverThreshold == false && new UsageSummary(new List<UsageWindow> { new("a", 71, null) }).OverThreshold, "alert is strictly above 70");
        Check(Format.Duration(30_000) == "<1m" && Format.Duration(45 * 60_000L) == "45m" && Format.Duration(130 * 60_000L) == "2h 10m" && Format.Duration(120 * 60_000L) == "2h" && Format.Duration((3 * 1440 + 4 * 60) * 60_000L) == "3d 4h", "durations read naturally");
        var udir = Path.Combine(Path.GetTempPath(), "ao-usage-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(udir);
        File.WriteAllText(Path.Combine(udir, "claude-code.json"), "{\"agent\":\"claude-code\",\"windows\":[{\"label\":\"Session\",\"usedPercentage\":80,\"resetsAt\":" + (nowS + 600) + "}]}");
        var one = UsageStore.Scan(udir, nowMsU);
        Check(one != null && one.Windows.Count == 1 && one.Windows[0].Label == "Session" && one.OverThreshold, "one agent: plain labels");
        File.WriteAllText(Path.Combine(udir, "codex.json"), "{\"agent\":\"codex\",\"windows\":[{\"label\":\"Weekly\",\"usedPercentage\":10,\"resetsAt\":" + (nowS + 600) + "}]}");
        File.WriteAllText(Path.Combine(udir, "wrapped.json"), "{\"command\":\"echo hi\"}");
        var two = UsageStore.Scan(udir, nowMsU);
        Check(two != null && two.Windows.Select(w => w.Label).OrderBy(x => x).SequenceEqual(new[] { "Claude Session", "Codex Weekly" }), "several agents: labels name the agent, unrelated json files ignored");
        Check(UsageStore.Scan(Path.Combine(udir, "nope"), nowMsU) == null, "a missing usage folder is no usage");
        try { Directory.Delete(udir, true); } catch { }


        // ---- phase 3 and 5: alerts, sounds, settings, autostart ----
        SessionEntry E(string agent = "claude-code", string project = "api", string? prompt = null, string? detail = null, string? nm = null, long? na = null) => new(agent, "s", project, "working", 1, 0, prompt, detail, nm, na);
        Check(Alerts.ForTransition(AgentState.Working, AgentState.NeedsInput, E(detail: "Bash"))?.Body == "Wants: Bash", "needs-you alert says what it wants");
        Check(Alerts.ForTransition(AgentState.Working, AgentState.NeedsInput, E(prompt: "fix login"))?.Body == "fix login", "needs-you falls back to the prompt");
        Check(Alerts.ForTransition(null, AgentState.NeedsInput, E()) is { SoundKey: "soundNeedsYou" }, "a session first seen already needing you does alert");
        Check(Alerts.ForTransition(null, AgentState.Working, E()) == null && Alerts.ForTransition(null, AgentState.Starting, E()) == null && Alerts.ForTransition(null, AgentState.Done, E()) == null, "first seen working, starting or done is silent");
        Check(Alerts.ForTransition(AgentState.Working, AgentState.Done, E()) is { SoundKey: "soundDone" } && Alerts.ForTransition(AgentState.Done, AgentState.Done, E()) == null, "finishing after work alerts once");
        Check(Alerts.ForTransition(AgentState.NeedsInput, AgentState.Done, E()) == null, "done after waiting is not announced as finished");
        Check(Alerts.ForTransition(AgentState.Working, AgentState.Warning, E()) is { SoundKey: "soundError" } && Alerts.ForTransition(AgentState.Working, AgentState.Stuck, E()) is { SoundKey: "soundStuck" } && Alerts.ForTransition(AgentState.Working, AgentState.Stopped, E()) is { SoundKey: "soundStopped" }, "error, stuck and stopped alert with their own sound keys");
        Check(Alerts.ForTransition(null, AgentState.Stopped, E()) == null, "a dead session first seen is old news, not an alert");
        Check(Alerts.ForNotify(E(nm: "build done", na: 100), AppSettings.Default, 50)?.Body == "build done", "a notify request alerts");
        Check(Alerts.ForNotify(E(nm: "build done", na: 100), AppSettings.Default, 100) == null && Alerts.ForNotify(E(nm: "build done", na: 100), AppSettings.Default with { CustomNotify = false }, 0) == null, "seen requests and a switched-off setting stay silent");
        Check(Alerts.ForNotify(E(nm: "  ", na: 100), AppSettings.Default, 0) == null && Alerts.ForNotify(E(nm: "x"), AppSettings.Default, 0) == null, "no message or no time means no alert");
        var snd = (Func<string, bool>)(f => f == "ding.wav");
        Check(SoundChoice.Parse("none", snd) is SoundChoice.None && SoundChoice.Parse(null, snd) is SoundChoice.None && SoundChoice.Parse("  ", snd) is SoundChoice.None, "none and empty are silent");
        Check(SoundChoice.Parse("Glass", snd) is SoundChoice.System { Name: "Asterisk" } && SoundChoice.Parse("basso", snd) is SoundChoice.System { Name: "Hand" } && SoundChoice.Parse("Hero", snd) is SoundChoice.System { Name: "Exclamation" } && SoundChoice.Parse("Frog", snd) is SoundChoice.System { Name: "Beep" }, "macOS sound names map to Windows system sounds");
        Check(SoundChoice.Parse("ding.wav", snd) is SoundChoice.File { Name: "ding.wav"} && SoundChoice.Parse("missing.wav", snd) is SoundChoice.None && SoundChoice.Parse("ding.mp3", snd) is SoundChoice.None, "only existing audio files in the sounds folder play");
        Check(SoundChoice.Parse("song.mp3", _ => true) is SoundChoice.File { Name: "song.mp3" } && SoundChoice.Parse("song.MP3", _ => true) is SoundChoice.File && SoundChoice.Parse("song.ogg", _ => true) is SoundChoice.None && SoundChoice.Parse("a\"b.mp3", _ => true) is SoundChoice.None && SoundChoice.Parse("../s.mp3", _ => true) is SoundChoice.None, "mp3 files play too; other formats, quotes and paths never");
        Check(SoundChoice.Parse("..\\evil.wav", _ => true) is SoundChoice.None && SoundChoice.Parse("a/b.wav", _ => true) is SoundChoice.None && SoundChoice.Parse("C:\\x.wav", _ => true) is SoundChoice.None, "paths and traversal never play");
        var st = SettingsStore.Parse("{\"dialogAlertsOn\":true,\"soundsOn\":false,\"customNotifyOn\":false,\"usageAlertOn\":false,\"stuckThresholdMinutes\":15,\"soundNotify\":\"ding.wav\",\"soundDone\":\"Ping\"}");
        Check(st.PopupAlerts && !st.Sounds && !st.CustomNotify && !st.UsageAlert && st.StuckMinutes == 15 && st.SoundNotify == "ding.wav" && st.SoundDone == "Ping" && st.SoundError == "none", "the shared setting keys are read");
        var dflt = AppSettings.Default;
        Check(dflt.PopupAlerts == false && dflt.CustomNotify && dflt.Sounds && dflt.UsageAlert && dflt.StuckMinutes == 8 && dflt.SoundNotify == "Glass", "defaults match the macOS app");
        var bad = SettingsStore.Parse("{\"dialogAlertsOn\":\"yes\",\"soundsOn\":1,\"stuckThresholdMinutes\":-5,\"soundDone\":\"../x\",\"soundNotify\":\"a\\\\b\"}");
        Check(!bad.PopupAlerts && bad.Sounds && bad.StuckMinutes == 8 && bad.SoundDone == "none" && bad.SoundNotify == "Glass", "wrong types, out-of-range numbers and path-like sound names fall back to defaults");
        Check(SettingsStore.Parse("{\"stuckThresholdMinutes\":0}").StuckMinutes == 0 && SettingsStore.Parse("{\"stuckThresholdMinutes\":241}").StuckMinutes == 8, "stuck threshold: 0 is off, above 240 is refused");
        var sfile = Path.Combine(Path.GetTempPath(), "ao-set2-" + Guid.NewGuid().ToString("N"), "settings.json");
        SettingsStore.SetBool("soundsOn", false, sfile); SettingsStore.SetInt("stuckThresholdMinutes", 30, sfile); SettingsStore.Save(PillMode.Taskbar, null, sfile);
        var back = SettingsStore.Load(sfile);
        Check(!back.Sounds && back.StuckMinutes == 30 && back.Mode == PillMode.Taskbar, "toggles and position all land in the one file");
        try { Directory.Delete(Path.GetDirectoryName(sfile)!, true); } catch { }
        Check(Autostart.CommandFor(@"C:\Program Files\Votive\VotiveWin.exe") == "\"C:\\Program Files\\Votive\\VotiveWin.exe\"" && Autostart.CommandFor("a\"b").Count(c => c == '"') == 2, "autostart command is the quoted exe path and nothing else");
        var testKey = @"Software\VotiveTest-" + Guid.NewGuid().ToString("N");
        try
        {
            Check(!Autostart.IsOn(testKey, "X"), "autostart starts off");
            Autostart.Set(true, @"C:\x\a.exe", testKey, "X");
            Check(Autostart.IsOn(testKey, "X"), "autostart turns on");
            Autostart.Set(false, @"C:\x\a.exe", testKey, "X");
            Check(!Autostart.IsOn(testKey, "X"), "autostart turns off again");
        }
        finally { try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(testKey, false); } catch { } }


        // ---- native: inside the taskbar ----
        var barRect = new Rectangle(0, 1032, 1920, 48); var trayRect = new Rectangle(1560, 1032, 360, 48);
        var inside = Placement.Compute(PillMode.Taskbar, bounds, work, new Size(120, 30), TaskbarEdge.Bottom, new Size(1920, 48), 96, null, barRect, trayRect, false);
        Check(inside == new Point(1432, 1041), "taskbar: inside the bar, left of the tray, centred in its height");
        Check(Placement.Compute(PillMode.Taskbar, bounds, work, new Size(120, 30), TaskbarEdge.Bottom, new Size(1920, 48), 96, null, barRect, null, false) == new Point(1572, 1041), "taskbar: no tray rectangle found, a sensible spot near the right end");
        Check(Placement.Compute(PillMode.Taskbar, bounds, work, new Size(120, 30), TaskbarEdge.Top, new Size(1920, 48), 96, null, new Rectangle(0, 0, 1920, 48), new Rectangle(1560, 0, 360, 48), false) == new Point(1432, 9), "taskbar on top: inside it too");
        Check(Placement.Compute(PillMode.Taskbar, bounds, work, new Size(120, 30), TaskbarEdge.Bottom, new Size(1920, 2), 96, null, new Rectangle(0, 1078, 1920, 2), trayRect, true) == new Point(1784, 994), "taskbar auto-hidden: falls back to the corner above where it is");
        Check(Placement.Compute(PillMode.Taskbar, bounds, work, new Size(120, 30), TaskbarEdge.Left, new Size(48, 1080), 96, null, new Rectangle(0, 0, 48, 1080), null, false) == new Point(56, 1034), "a vertical taskbar is too narrow for the pill: corner beside it");
        Check(Placement.Compute(PillMode.Taskbar, bounds, work, new Size(120, 30), TaskbarEdge.Bottom, new Size(1920, 48), 96, null, new Rectangle(0, 1056, 1920, 24), trayRect, false) != new Point(1432, 1059), "a taskbar too short for the pill does not squash it in");
        Check(Placement.Compute(PillMode.Taskbar, bounds, work, new Size(120, 30), TaskbarEdge.Bottom, new Size(1920, 48), 96, null, barRect, new Rectangle(5000, 1032, 10, 48), false) == new Point(1572, 1041), "a nonsense tray rectangle is ignored");


        // ---- the visible bar, from the work area ----
        var vb = Placement.VisibleBar(new Rectangle(0, 0, 2560, 1440), new Rectangle(0, 0, 2560, 1392));
        Check(vb is { Edge: TaskbarEdge.Bottom } && vb.Value.Bar == new Rectangle(0, 1392, 2560, 48), "visible bar: bottom taskbar is the strip left out of the work area (48 px, not the window's 72)");
        Check(Placement.VisibleBar(new Rectangle(0, 0, 1920, 1080), new Rectangle(0, 48, 1920, 1032)) is { Edge: TaskbarEdge.Top } t && t.Bar == new Rectangle(0, 0, 1920, 48), "visible bar: top taskbar");
        Check(Placement.VisibleBar(new Rectangle(0, 0, 1920, 1080), new Rectangle(48, 0, 1872, 1080)) is { Edge: TaskbarEdge.Left } l && l.Bar.Width == 48, "visible bar: left taskbar");
        Check(Placement.VisibleBar(new Rectangle(0, 0, 1920, 1080), new Rectangle(0, 0, 1872, 1080)) is { Edge: TaskbarEdge.Right } r && r.Bar.Left == 1872, "visible bar: right taskbar");
        Check(Placement.VisibleBar(new Rectangle(0, 0, 1920, 1080), new Rectangle(0, 0, 1920, 1080)) == null, "visible bar: nothing left out means no bar or an auto-hidden one");
        var real = Placement.Compute(PillMode.Taskbar, new Rectangle(0, 0, 2560, 1440), new Rectangle(0, 0, 2560, 1392), new Size(99, 32), TaskbarEdge.Bottom, new Size(2560, 48), 96, null, new Rectangle(0, 1392, 2560, 48), new Rectangle(2306, 1368, 254, 72), false);
        Check(real == new Point(2199, 1400), "this PC: 99x32 pill centred in the 48 px bar at Y=1392, left of the tray at x=2306");

        // ---- the master switch for agent changes (AGEN-22): only an exact `true` is on ----
        var swDir = Path.Combine(Path.GetTempPath(), "ao-switch-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(swDir);
        var swFile = Path.Combine(swDir, "settings.json");
        Check(!SettingsStore.GetBool("agentWritesAllowed", swFile), "agent changes: off when there is no settings file");
        File.WriteAllText(swFile, "{\"agentWritesAllowed\":true,\"soundsOn\":false}");
        Check(SettingsStore.GetBool("agentWritesAllowed", swFile), "agent changes: on only when the user's file says true");
        foreach (var badFile in new[] { "{\"agentWritesAllowed\":\"true\"}", "{\"agentWritesAllowed\":1}", "{\"agentWritesAllowed\":null}", "{\"agentWritesAllowed\":[true]}", "[true]", "not json", "{\"agentWritesAllowed\":false}", "{}" })
        { File.WriteAllText(swFile, badFile); Check(!SettingsStore.GetBool("agentWritesAllowed", swFile), "agent changes: off for " + badFile); }
        File.WriteAllText(swFile, "{\"agentWritesAllowed\":true,\"pad\":\"" + new string('x', 70_000) + "\"}");
        Check(!SettingsStore.GetBool("agentWritesAllowed", swFile), "agent changes: an oversized settings file reads as off");
        File.WriteAllText(swFile, "{\"soundsOn\":false}");
        SettingsStore.SetBool("agentWritesAllowed", true, swFile);
        Check(SettingsStore.GetBool("agentWritesAllowed", swFile) && !SettingsStore.Load(swFile).Sounds, "agent changes: the menu toggle keeps every other setting");
        try { Directory.Delete(swDir, true); } catch { }

        // ---- native taskbar button (AGEN-46): icon, badge, progress, hover card, click ----
        var none = TaskbarModel.Summarize(Array.Empty<AgentState>(), null);
        Check(!none.Any && none.Badge == BadgeKind.None && none.Progress == ProgressKind.None && none.Tooltip == "No agent sessions", "button: no sessions shows a quiet button");
        var calm = TaskbarModel.Summarize(new[] { AgentState.Done, AgentState.Working, AgentState.Starting }, null);
        Check(calm.Any && calm.Worst == AgentState.Working && calm.Badge == BadgeKind.None && calm.Progress == ProgressKind.None && calm.Tooltip == "3 sessions", "button: working outranks done and starting, no badge, no progress");
        var need = TaskbarModel.Summarize(new[] { AgentState.Working, AgentState.NeedsInput, AgentState.NeedsInput, AgentState.Done }, null);
        Check(need.Worst == AgentState.NeedsInput && need.Badge == BadgeKind.NeedsYou && need.BadgeCount == 2 && need.Progress == ProgressKind.Paused && need.ProgressPercent == 100 && need.Tooltip == "4 sessions, 2 need you", "button: needs-you wins, badge counts them, progress is the paused yellow bar");
        var err = TaskbarModel.Summarize(new[] { AgentState.NeedsInput, AgentState.Warning, AgentState.Stopped }, 40);
        Check(err.Worst == AgentState.NeedsInput && err.Badge == BadgeKind.NeedsYou && err.Progress == ProgressKind.Error && err.ProgressPercent == 100 && err.Tooltip == "3 sessions, 1 need you, 1 error, 1 stopped", "button: an error turns the bar red even while something needs you; usage does not hide it");
        var stuck = TaskbarModel.Summarize(new[] { AgentState.Stuck, AgentState.Working }, null);
        Check(stuck.Worst == AgentState.Stuck && stuck.Badge == BadgeKind.Stuck && stuck.Progress == ProgressKind.Paused && stuck.Tooltip == "2 sessions, 1 stuck", "button: stuck gets the clock badge and the paused bar");
        var use = TaskbarModel.Summarize(new[] { AgentState.Working }, 74);
        Check(use.Progress == ProgressKind.Normal && use.ProgressPercent == 74 && use.Badge == BadgeKind.None && use.Tooltip == "1 session", "button: plan usage fills the bar when nothing is wrong");
        Check(TaskbarModel.Summarize(new[] { AgentState.Working }, 250).ProgressPercent == 100 && TaskbarModel.Summarize(new[] { AgentState.Working }, -5).ProgressPercent == 0, "button: usage is clamped to 0 to 100");
        Check(TaskbarModel.Summarize(Enumerable.Repeat(AgentState.NeedsInput, 150).ToArray(), null).BadgeCount == 99, "button: the badge count stops at 99");
        var three = HoverCard.Layout(3, 400, 300);
        Check(three.Width == 360 && three.Height == 8 + 36 + 3 * 30 + 8 && three.VisibleRows == 3 && three.Overflow == 0, "hover card: three sessions fit; the card fills the space Windows allows, up to 360");
        var many = HoverCard.Layout(20, 400, 300);
        Check(many.Height <= 300 && many.VisibleRows + many.Overflow == 20 && many.Overflow > 0 && many.VisibleRows >= 5, "hover card: 20 sessions are cut to fit the height, the rest counted as '+N more'");
        Check(HoverCard.Layout(0, 400, 300).VisibleRows == 0 && HoverCard.Layout(0, 400, 300).Height == 8 + 36 + 30 + 8, "hover card: no sessions still shows one 'nothing running' row");
        Check(HoverCard.Layout(3, 200, 300).Width == 200 && HoverCard.Layout(3, 1000, 300).Width == 360 && HoverCard.Layout(3, 0, 300).Width == 0, "hover card: width never exceeds the space Windows allows, nor 360");
        Check(HoverCard.Layout(5, 400, 40).VisibleRows == 0 && HoverCard.Layout(5, 400, 40).Height <= 40 && HoverCard.Layout(5, 400, 40).Overflow == 5, "hover card: a tiny thumbnail area is never exceeded and every session is counted as overflow");
        var small3 = HoverCard.Layout(3, 200, 105);
        Check(small3.VisibleRows == 3 && small3.Overflow == 0 && small3.RowHeight == 20 && small3.HeaderHeight == 24 && small3.Height == 8 + 24 + 3 * 20 && small3.Height <= 105, "hover card: the 200x105 thumbnail Windows really offers uses compact rows and shows 3 sessions");
        var small4 = HoverCard.Layout(4, 200, 105);
        Check(small4.VisibleRows == 2 && small4.Overflow == 2 && small4.Height <= 105 && small4.Width == 200, "hover card: 4 sessions in 200x105 show 2 and '+2 more', never a card that is only '+4 more'");
        Check(HoverCard.Layout(3, 400, 300).RowHeight == 30 && HoverCard.Layout(3, 400, 300).HeaderHeight == 36, "hover card: a roomy area keeps the regular rows");
        Check(ClickPolicy.Decide(0xF120) == HostAction.OpenList && ClickPolicy.Decide(0xF122) == HostAction.OpenList && ClickPolicy.Decide(0xF030) == HostAction.OpenList, "click: restore and maximise open our list instead of showing the host window");
        Check(ClickPolicy.Decide(0xF020) == HostAction.Pass && ClickPolicy.Decide(0xF060) == HostAction.Pass && ClickPolicy.Decide(0xF010) == HostAction.Pass, "click: minimise, close and move pass through untouched");

        Console.WriteLine(_failed == 0 ? "ALL PASSED" : _failed + " FAILED");
        return _failed == 0 ? 0 : 1;
    }
}
