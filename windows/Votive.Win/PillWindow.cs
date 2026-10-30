using System.ComponentModel;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using Microsoft.Win32;

namespace Votive.Win;

/// <summary>
/// A small always-on-top pill: one dot per session, worst state first. It never takes focus, never shows in
/// the taskbar or Alt-Tab, and takes its corners, shadow and acrylic from Windows itself. Where it sits is a
/// setting: top of the screen, inside the taskbar (left of the tray), where the user dragged it, or nowhere
/// when only the tray icon is wanted.
/// </summary>
public sealed class PillWindow : Form
{
    const int Dot = 12, Gap = 9, Pad = 12, MaxDots = 6, DragSlop = 4, KeepOnTopMs = 1000;
    const int WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x00000080;

    readonly ToolTip _tip = new();
    // While the pill is inside the taskbar, the taskbar moves itself to the front whenever it is clicked.
    // This puts the pill back, once a second, and only in that mode (it is stopped everywhere else).
    readonly System.Windows.Forms.Timer _keepOnTop = new() { Interval = KeepOnTopMs };
    List<(AgentState State, SessionEntry Entry)> _rows = new();
    AppSettings _settings = AppSettings.Default;
    Point _dragFrom, _dragStart;
    bool _dragging, _moved, _inTaskbar;

    /// <summary>For --render: lay out and paint without moving or showing the window.</summary>
    [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public bool RenderOnly { get; set; }

    /// <summary>Raised once when the user drops the pill somewhere new.</summary>
    public event Action<Point>? Dropped;

    /// <summary>Raised on a plain click (no drag); the rectangle is the pill's place on screen.</summary>
    public event Action<Rectangle>? Clicked;

    public PillWindow()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        DoubleBuffered = true;
        Size = new Size(1, 1);
        _tip.InitialDelay = 250;
        Theme.Refresh();
        BackColor = Theme.UseBackdrop ? Color.Black : Theme.Surface(!Dark());
        _keepOnTop.Tick += (_, _) => { if (Visible) Native.RaiseTopmost(Handle); };
        SystemEvents.DisplaySettingsChanged += OnDisplayChanged;   // monitor or taskbar moved: place it again
        SystemEvents.UserPreferenceChanged += OnPreferenceChanged; // light/dark changed: repaint
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW; return cp; }
    }

    int S(int v) => (int)Math.Round(v * DeviceDpi / 96.0);

    // Inside the taskbar the pill matches the taskbar's theme; floating, it matches the apps theme.
    bool Dark() => _inTaskbar ? !Theme.TaskbarLight : !Theme.AppsLight;

    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Restyle(); }

    void Restyle()
    {
        if (!IsHandleCreated) return;
        bool dark = Dark();
        BackColor = Theme.UseBackdrop ? Color.Black : Theme.Surface(!dark);
        // Inside the taskbar the pill uses Mica (quiet, close to the bar's own colour); floating, acrylic like other flyouts.
        Native.Style(Handle, dark, Native.Corner.Round, Theme.UseBackdrop ? (_inTaskbar ? Native.Backdrop.Mica : Native.Backdrop.Acrylic) : null);
    }

    public void ApplySettings(AppSettings s) { _settings = s; Relayout(); }

    /// <summary>Replace what is shown. Hides the pill when there is nothing to show or the user wants the tray icon only.</summary>
    public void SetRows(List<(AgentState State, SessionEntry Entry)> rows)
    {
        _rows = rows;
        _tip.SetToolTip(this, string.Join("\n", rows.Select(r => $"{r.Entry.Agent} · {r.Entry.Project} — {StateResolver.Label(r.State)}")));
        Relayout();
    }

    void Relayout()
    {
        if (_rows.Count == 0 || _settings.Mode == PillMode.TrayOnly) { _keepOnTop.Stop(); if (Visible) Hide(); return; }
        int shown = Math.Min(_rows.Count, MaxDots);
        int extra = _rows.Count - shown;
        // Taller floating, slimmer inside a taskbar so it sits like another taskbar item.
        var visible = RenderOnly ? null : VisibleBar();
        int h = _settings.Mode == PillMode.Taskbar && visible is { Edge: TaskbarEdge.Bottom or TaskbarEdge.Top } v ? Math.Min(S(32), Math.Max(S(22), v.Bar.Height - S(16))) : S(32);
        int w = S(Pad) * 2 + shown * S(Dot) + (shown - 1) * S(Gap) + (extra > 0 ? S(30) : 0);
        Size = new Size(w, h);
        if (RenderOnly) { Invalidate(); return; }
        Reposition();
        if (!Visible) Show();
        Restyle();
        Invalidate();
    }

    /// <summary>Put the pill where the current setting says. Never while the user is dragging it.</summary>
    public void Reposition()
    {
        if (_dragging || _settings.Mode == PillMode.TrayOnly) return;
        var screen = Screen.PrimaryScreen ?? Screen.AllScreens[0];
        var visible = VisibleBar();
        // No visible bar means none, or one that auto-hides; the placement falls back to the corner then.
        var (edge, barSize) = visible is { } vb ? (vb.Edge, vb.Bar.Size) : Placement.QueryTaskbar();
        var tray = _settings.Mode == PillMode.Taskbar ? Native.TaskbarGeometry().Tray : null;
        bool autoHide = _settings.Mode == PillMode.Taskbar && (visible == null || Native.TaskbarAutoHides());
        var p = Placement.Compute(_settings.Mode, screen.Bounds, screen.WorkingArea, Size, edge, barSize, DeviceDpi, _settings.Custom, visible?.Bar, tray, autoHide);
        bool inside = _settings.Mode == PillMode.Taskbar && !autoHide && visible is { Edge: TaskbarEdge.Bottom or TaskbarEdge.Top };
        if (inside != _inTaskbar) { _inTaskbar = inside; Restyle(); }
        if (p is { } at && Location != at) Location = at;
        if (_inTaskbar) { Native.RaiseTopmost(Handle); _keepOnTop.Start(); } else _keepOnTop.Stop();
        if (Environment.GetEnvironmentVariable("VOTIVE_DEBUG") == "1")   // for checking placement on a real desktop
        {
            try { File.AppendAllText(Path.Combine(EventStore.Root(), "debug.txt"), $"{DateTime.Now:HH:mm:ss} mode={_settings.Mode} wanted={p} size={Size} bounds={Bounds} dpi={DeviceDpi} bar={visible?.Bar} tray={tray} inside={_inTaskbar}\n"); } catch { }
        }
    }

    static (TaskbarEdge Edge, Rectangle Bar)? VisibleBar()
    {
        var s = Screen.PrimaryScreen ?? Screen.AllScreens[0];
        return Placement.VisibleBar(s.Bounds, s.WorkingArea);
    }

    void OnDisplayChanged(object? sender, EventArgs e) { try { BeginInvoke(Relayout); } catch { /* closing */ } }
    void OnPreferenceChanged(object? sender, UserPreferenceChangedEventArgs e)
    {
        if (e.Category != UserPreferenceCategory.General && e.Category != UserPreferenceCategory.Color) return;
        try { BeginInvoke(() => { Theme.Refresh(); Restyle(); Invalidate(); }); } catch { /* closing */ }
    }
    protected override void OnDpiChanged(DpiChangedEventArgs e) { base.OnDpiChanged(e); Relayout(); }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SystemEvents.DisplaySettingsChanged -= OnDisplayChanged;
            SystemEvents.UserPreferenceChanged -= OnPreferenceChanged;
            _keepOnTop.Dispose();
        }
        base.Dispose(disposing);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        bool light = !Dark();
        int shown = Math.Min(_rows.Count, MaxDots);
        int dot = S(Dot), gap = S(Gap), pad = S(Pad), y = (Height - dot) / 2;
        for (int i = 0; i < shown; i++)
        {
            int x = pad + i * (dot + gap);
            using var b = new SolidBrush(StateResolver.ColorOf(_rows[i].State));
            g.FillEllipse(b, x, y, dot, dot);
            if (StateResolver.WantsAttention(_rows[i].State))
            {
                using var ring = new Pen(Theme.Text(light), Math.Max(1.5f, S(2) * 0.7f));
                int r = S(2);
                g.DrawEllipse(ring, x - r, y - r, dot + r + 1, dot + r + 1);   // a ring, not only a colour: shape carries meaning too
            }
        }
        if (_rows.Count > shown)
        {
            using var f = Theme.Body(8.5f, FontStyle.Bold);
            using var t = new SolidBrush(Theme.Text(light));
            var size = g.MeasureString("+" + (_rows.Count - shown), f);
            g.DrawString("+" + (_rows.Count - shown), f, t, pad + shown * (dot + gap) - S(1), (Height - size.Height) / 2);
        }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) { _dragging = true; _moved = false; _dragFrom = e.Location; _dragStart = Location; }
        base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        // Inside the taskbar the pill belongs to the taskbar; dragging is for the floating modes.
        if (_dragging && !_inTaskbar)
        {
            var next = new Point(Location.X + e.X - _dragFrom.X, Location.Y + e.Y - _dragFrom.Y);
            if (!_moved && (Math.Abs(next.X - _dragStart.X) > DragSlop || Math.Abs(next.Y - _dragStart.Y) > DragSlop)) _moved = true;
            if (_moved) Location = next;
        }
        base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        bool dropped = _dragging && _moved, clicked = _dragging && !_moved && e.Button == MouseButtons.Left;
        _dragging = false;
        if (dropped) Dropped?.Invoke(Location);
        else if (clicked) Clicked?.Invoke(Bounds);
        base.OnMouseUp(e);
    }
}
