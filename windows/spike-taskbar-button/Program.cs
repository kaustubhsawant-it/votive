using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using Votive.Win;

namespace Spike;

static class Program
{
    static string? Arg(string[] a, string n) { int i = Array.IndexOf(a, n); return i >= 0 && i + 1 < a.Length ? a[i + 1] : null; }

    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new Host(Arg(args, "--scenario") ?? "needs", Arg(args, "--log"), int.Parse(Arg(args, "--seconds") ?? "60")));
    }
}

/// <summary>
/// The host window: minimised, so Windows keeps one taskbar button for it and lays that button out with the others.
/// Everything the button shows is set from here: the icon (worst state), an overlay badge, the progress bar, and the
/// hover card (an "iconic thumbnail" picture we draw). A click asks the window to restore; we answer by opening our own
/// list and keeping the host minimised.
/// </summary>
sealed class Host : Form
{
    readonly uint _buttonCreated = Native.RegisterWindowMessage("TaskbarButtonCreated");
    readonly List<(string Project, AgentState State, string Age)> _sessions;
    readonly TaskbarButtonState _state;
    readonly string? _logFile;
    ITaskbarList3? _taskbar;
    Form? _list;
    bool _forcing;

    public Host(string scenario, string? log, int seconds)
    {
        _logFile = log;
        _sessions = Scenario(scenario);
        _state = TaskbarModel.Summarize(_sessions.Select(s => s.State).ToList(), scenario == "calm" ? 74 : null);
        Text = "Votive";
        ShowInTaskbar = true;
        WindowState = FormWindowState.Minimized;
        Size = new Size(320, 200);
        Icon = MakeIcon(_state.Worst, 32);
        var end = new System.Windows.Forms.Timer { Interval = seconds * 1000 };
        end.Tick += (_, _) => { var p = Process.GetCurrentProcess(); Log($"memory: working set {p.WorkingSet64 / 1048576.0:F1} MB, private {p.PrivateMemorySize64 / 1048576.0:F1} MB"); Application.Exit(); };
        end.Start();
        Log($"start scenario={scenario}: {_state.Tooltip}; worst={_state.Worst} badge={_state.Badge}x{_state.BadgeCount} progress={_state.Progress}/{_state.ProgressPercent}");
    }

    static List<(string, AgentState, string)> Scenario(string name) => name switch
    {
        "error" => new() { ("api", AgentState.Warning, "2m"), ("web", AgentState.NeedsInput, "5m"), ("docs", AgentState.Working, "now") },
        "calm" => new() { ("api", AgentState.Working, "now"), ("web", AgentState.Done, "3m"), ("docs", AgentState.Starting, "now") },
        "many" => Enumerable.Range(1, 20).Select(i => ($"project-{i:00}", i % 5 == 0 ? AgentState.NeedsInput : i % 4 == 0 ? AgentState.Stuck : i % 2 == 0 ? AgentState.Working : AgentState.Done, i + "m")).ToList(),
        _ => new() { ("api", AgentState.NeedsInput, "1m"), ("web", AgentState.NeedsInput, "4m"), ("docs", AgentState.Done, "9m"), ("mobile", AgentState.Working, "now") },
    };

    void Log(string m) { if (_logFile != null) try { File.AppendAllText(_logFile, $"{DateTime.Now:HH:mm:ss.fff}  {m}\n"); } catch { } }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int on = 1;   // draw the thumbnail and the live preview from our own bitmaps, not from the (empty, minimised) window
        Log($"handle created; force-iconic hr={Native.DwmSetWindowAttribute(Handle, Native.DWMWA_FORCE_ICONIC_REPRESENTATION, ref on, 4):X8}, has-iconic hr={Native.DwmSetWindowAttribute(Handle, Native.DWMWA_HAS_ICONIC_BITMAP, ref on, 4):X8}");
    }


    protected override void WndProc(ref Message m)
    {
        if (m.Msg == _buttonCreated && _buttonCreated != 0) { InitTaskbar(); }
        else if (m.Msg == Native.WM_SYSCOMMAND)
        {
            var act = ClickPolicy.Decide(m.WParam.ToInt32());
            Log($"WM_SYSCOMMAND 0x{m.WParam.ToInt64():X} -> {act}");
            if (act == HostAction.OpenList) { ShowList(); m.Result = IntPtr.Zero; return; }   // swallowed: the host never restores
        }
        else if (m.Msg == Native.WM_DWMSENDICONICTHUMBNAIL)
        {
            int w = (int)((m.LParam.ToInt64() >> 16) & 0xFFFF), h = (int)(m.LParam.ToInt64() & 0xFFFF);
            var lay = HoverCard.Layout(_sessions.Count, w, h);
            using var bmp = RenderCard(lay);
            var hb = bmp.GetHbitmap();
            Log($"thumbnail asked: max {w}x{h} -> card {lay.Width}x{lay.Height} rows={lay.VisibleRows} +{lay.Overflow}; SetIconicThumbnail hr={Native.DwmSetIconicThumbnail(Handle, hb, 0):X8}");
            Native.DeleteObject(hb); m.Result = IntPtr.Zero; return;
        }
        else if (m.Msg == Native.WM_DWMSENDICONICLIVEPREVIEWBITMAP)
        {
            var lay = HoverCard.Layout(_sessions.Count, 640, 480);
            using var bmp = RenderCard(lay);
            var hb = bmp.GetHbitmap();
            Log($"live preview asked -> card {lay.Width}x{lay.Height}; SetIconicLivePreviewBitmap hr={Native.DwmSetIconicLivePreviewBitmap(Handle, hb, IntPtr.Zero, 0):X8}");
            Native.DeleteObject(hb); m.Result = IntPtr.Zero; return;
        }
        base.WndProc(ref m);
    }

    // Fallback if the shell restores the window without a system command: put it back and open our list.
    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (WindowState != FormWindowState.Minimized && !_forcing && IsHandleCreated)
        {
            _forcing = true; Log("host was restored by the shell WITHOUT a system command; forcing it minimised"); WindowState = FormWindowState.Minimized; _forcing = false; ShowList();
        }
    }

    void InitTaskbar()
    {
        try
        {
            _taskbar = (ITaskbarList3)new TaskbarListCom();
            Log($"TaskbarButtonCreated received; ITaskbarList3 created, HrInit hr={_taskbar.HrInit():X8}");
            int badgeHr = 0;
            if (_state.Badge != BadgeKind.None)
            {
                using var bmp = new Bitmap(16, 16);
                using (var g = Graphics.FromImage(bmp)) { g.Clear(Color.Transparent); Badge.Draw(g, BadgeState(_state.Badge), new Rectangle(0, 0, 16, 16)); }
                var hIcon = bmp.GetHicon();
                badgeHr = _taskbar.SetOverlayIcon(Handle, hIcon, _state.Tooltip);
                Native.DestroyIcon(hIcon);
            }
            int tbpf = _state.Progress switch { ProgressKind.Normal => Native.TBPF_NORMAL, ProgressKind.Error => Native.TBPF_ERROR, ProgressKind.Paused => Native.TBPF_PAUSED, _ => Native.TBPF_NOPROGRESS };
            int p1 = _taskbar.SetProgressState(Handle, tbpf), p2 = _state.Progress == ProgressKind.None ? 0 : _taskbar.SetProgressValue(Handle, (ulong)_state.ProgressPercent, 100);
            Log($"overlay icon hr={badgeHr:X8}; progress state hr={p1:X8} value hr={p2:X8}; tooltip hr={_taskbar.SetThumbnailTooltip(Handle, _state.Tooltip):X8}");
        }
        catch (Exception ex) { Log("INIT FAILED: " + ex); }
    }

    static AgentState BadgeState(BadgeKind b) => b switch { BadgeKind.NeedsYou => AgentState.NeedsInput, BadgeKind.Error => AgentState.Warning, BadgeKind.Stuck => AgentState.Stuck, _ => AgentState.Stopped };

    static Icon MakeIcon(AgentState s, int px)
    {
        using var bmp = new Bitmap(px, px);
        using (var g = Graphics.FromImage(bmp)) { g.Clear(Color.Transparent); Badge.Draw(g, s, new Rectangle(1, 1, px - 2, px - 2)); }
        var h = bmp.GetHicon(); var ic = (Icon)Icon.FromHandle(h).Clone(); Native.DestroyIcon(h); return ic;
    }

    /// <summary>The hover card and the list are the same picture, drawn at the size Windows allows.</summary>
    Bitmap RenderCard(HoverLayout lay)
    {
        var bmp = new Bitmap(Math.Max(1, lay.Width), Math.Max(1, lay.Height));
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        g.Clear(Color.FromArgb(32, 32, 32));
        bool compact = lay.RowHeight < 30;
        using var white = new SolidBrush(Color.White); using var grey = new SolidBrush(Color.FromArgb(170, 170, 170));
        using var title = new Font("Segoe UI Semibold", compact ? 8.5f : 10f); using var body = new Font("Segoe UI", compact ? 8f : 9.5f);
        int text = compact ? 2 : 6, badge = lay.RowHeight - (compact ? 4 : 10), badgeTop = (lay.RowHeight - badge) / 2;
        if (compact) g.DrawString("Votive  " + _state.Tooltip, title, white, new RectangleF(lay.Pad + 2, lay.Pad, lay.Width - 2 * lay.Pad, lay.HeaderHeight), new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap });
        else { g.DrawString("Votive", title, white, lay.Pad + 2, lay.Pad); g.DrawString(_state.Tooltip, body, grey, lay.Pad + 2, lay.Pad + 17); }
        int y = lay.Pad + lay.HeaderHeight;
        var ordered = _sessions.OrderBy(s => StateResolver.Priority(s.State)).ToList();
        if (ordered.Count == 0) g.DrawString("Nothing running", body, grey, lay.Pad + 2, y + text);
        int labelX = Math.Max(lay.Width - (compact ? 78 : 120), lay.Pad + 60);
        for (int i = 0; i < lay.VisibleRows; i++, y += lay.RowHeight)
        {
            var (project, state, age) = ordered[i];
            Badge.Draw(g, state, new Rectangle(lay.Pad + 2, y + badgeTop, badge, badge));
            g.DrawString(project, body, white, lay.Pad + 4 + badge + 4, y + text);
            g.DrawString(StateResolver.Label(state) + "  " + age, body, grey, labelX, y + text);
        }
        if (lay.Overflow > 0) g.DrawString($"+{lay.Overflow} more", body, grey, lay.Pad + 4 + badge + 4, y + text);
        return bmp;
    }

    void ShowList()
    {
        try
        {
            if (_list is { IsDisposed: false }) { _list.Close(); }
            var wa = Screen.PrimaryScreen!.WorkingArea;
            var lay = HoverCard.Layout(_sessions.Count, 360, 420);
            var pic = RenderCard(lay);
            _list = new Form { FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.Manual, ShowInTaskbar = false, TopMost = true, Size = new Size(lay.Width, lay.Height), BackgroundImage = pic };
            _list.Location = new Point(wa.Right - lay.Width - 8, wa.Bottom - lay.Height - 8);
            var t = new System.Windows.Forms.Timer { Interval = 8000 }; t.Tick += (_, _) => { t.Stop(); _list?.Close(); }; t.Start();
            _list.Show();
            Log($"list shown at {_list.Location} {lay.Width}x{lay.Height}; host window state = {WindowState}");
        }
        catch (Exception ex) { Log("ShowList failed: " + ex.Message); }
    }
}
