namespace Votive.Win;

/// <summary>
/// `--render file.png`: paints the pill, the expanded list and an alert panel with sample data into one
/// picture, with no screen involved. Used to look at the design on a machine whose desktop is locked.
/// </summary>
static class Render
{
    static string _log = "";
    static void Step(string m) { try { File.AppendAllText(_log, DateTime.Now.ToString("HH:mm:ss.fff") + " " + m + "\n"); } catch { } }

    public static int Run(string outPath, bool light = false)
    {
        _log = outPath + ".log"; File.WriteAllText(_log, "");
        Step("start");
        ApplicationConfiguration.Initialize();
        Theme.Override = light;
        Theme.UseBackdrop = false;   // a drawn picture cannot show acrylic: paint the solid surface instead
        Theme.Refresh();
        Step("initialized");
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        SessionEntry E(string project, string agent, string ev, long agoMs, string? prompt = null, string? detail = null) => new(agent, project, project, ev, now - agoMs, 0, prompt, detail);
        var rows = new List<(AgentState, SessionEntry)>
        {
            (AgentState.NeedsInput, E("api", "claude-code", "waiting", 25_000, "add rate limiting to the login endpoint", "Bash")),
            (AgentState.Warning, E("mobile", "claude-code", "error", 95_000, "fix the crash on the settings screen")),
            (AgentState.Stuck, E("slow", "codex", "working", 20 * 60_000, "migrate the old reports to the new schema")),
            (AgentState.Stopped, E("crashed", "claude-code", "working", 3 * 60_000, "refactor the payment module")),
            (AgentState.Working, E("site", "claude-code", "working", 12_000, "write the launch page copy and check the links")),
            (AgentState.Starting, E("lab", "gemini", "starting", 3_000)),
            (AgentState.Done, E("docs", "claude-code", "done", 4 * 60_000, "update the README for version 2")),
            (AgentState.Done, E("infra", "aider", "done", 3_600_000, "bump the node image")),
        };
        var usage = new UsageSummary(new List<UsageWindow> { new("Session", 78, 2 * 3_600_000L + 600_000), new("Weekly", 41, 3 * 86_400_000L + 5 * 3_600_000L) });

        using var pill = new PillWindow { RenderOnly = true };
        Step("pill created");
        pill.SetRows(rows);
        Step("pill laid out");
        using var flyout = new FlyoutWindow();
        flyout.Update(rows, usage, now);
        Step("flyout laid out");
        using var alert = new AlertWindow();
        alert.Prepare(new AlertInfo("api · claude-code needs you", "Wants: Bash", AgentState.NeedsInput, "soundNeedsYou"));
        Step("alert laid out");

        int W = 760, H = 40 + pill.Height + 30 + Math.Max(flyout.Height, alert.Height + 20) + 30;
        using var canvas = new Bitmap(W, H);
        using var g = Graphics.FromImage(canvas);
        g.Clear(light ? Color.FromArgb(225, 228, 232) : Color.FromArgb(15, 15, 17));
        using var label = new Font("Segoe UI", 8.5f);
        void Blit(Form f, int x, int y, string caption)
        {
            using var shot = new Bitmap(f.Width, f.Height);
            Step("drawing " + caption);
            f.DrawToBitmap(shot, new Rectangle(0, 0, f.Width, f.Height));
            Step("drew " + caption);
            g.DrawImage(shot, x, y);
            TextRenderer.DrawText(g, caption, label, new Point(x, y - 18), light ? Color.FromArgb(90, 90, 96) : Color.FromArgb(130, 130, 138));
        }
        int y0 = 26;
        Blit(pill, 20, y0, "the pill (8 sessions: 6 dots and +2)");
        int y1 = y0 + pill.Height + 36;
        Blit(flyout, 20, y1, "click it: the expanded list with usage");
        Blit(alert, 20 + flyout.Width + 24, y1, "an alert panel");
        canvas.Save(outPath, System.Drawing.Imaging.ImageFormat.Png);
        Console.WriteLine($"wrote {outPath} ({W}x{H})");
        return 0;
    }
}
