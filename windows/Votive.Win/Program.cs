using System.Diagnostics;

namespace Votive.Win;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Contains("--self-test")) return SelfTest.Run();
        var gi = Array.IndexOf(args, "--geometry");
        if (gi >= 0 && gi + 1 < args.Length)
        {
            Theme.Refresh(); var (bar, tray) = Native.TaskbarGeometry(); var (edge, size) = Placement.QueryTaskbar();
            File.WriteAllText(args[gi + 1], $"taskbar={bar} tray={tray} edge={edge} reported={size} autohide={Native.TaskbarAutoHides()} screen={Screen.PrimaryScreen?.Bounds} work={Screen.PrimaryScreen?.WorkingArea} backdrop={Native.HasBackdrop} build={Environment.OSVersion.Version.Build} appsLight={Theme.AppsLight} taskbarLight={Theme.TaskbarLight}\n");
            return 0;
        }
        var r = Array.IndexOf(args, "--render");
        if (r >= 0 && r + 1 < args.Length) return Render.Run(args[r + 1], args.Contains("--light"));

        using var single = new Mutex(true, @"Local\VotiveWin", out bool first);
        if (!first) return 0;   // already running in this session

        ApplicationConfiguration.Initialize();
        Application.SetColorMode(SystemColorMode.System);   // menus follow the Windows light/dark setting
        using var app = new App();
        if (args.Contains("--demo-open")) app.DemoOpen();   // for checking the flyout and alert on a real desktop
        // --report <file>: after a minute of idling write the memory numbers, for the AGEN-12 kill rule.
        var i = Array.IndexOf(args, "--report");
        if (i >= 0 && i + 1 < args.Length)
        {
            var file = args[i + 1];
            var t = new System.Windows.Forms.Timer { Interval = 60_000 };
            t.Tick += (_, _) =>
            {
                t.Stop();
                GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
                using var p = Process.GetCurrentProcess();
                File.WriteAllText(file, $"workingSetMB={p.WorkingSet64 / 1048576.0:F1} privateMB={p.PrivateMemorySize64 / 1048576.0:F1} threads={p.Threads.Count} handles={p.HandleCount}\n");
            };
            t.Start();
        }
        Application.Run(app);
        return 0;
    }
}
