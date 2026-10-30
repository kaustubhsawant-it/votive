using System.Drawing.Drawing2D;
using System.Drawing.Text;

namespace Votive.Win;

/// <summary>
/// A toast-style panel that says what just happened ("api needs you"): acrylic and system corners, a status
/// badge, and it sits where Windows puts its own toasts, bottom right above the taskbar. It never takes focus
/// (you may be mid sentence in a terminal), fades in, goes away on its own after a few seconds or on a click.
/// </summary>
public sealed class AlertWindow : Form
{
    const int WidthPx = 360, Pad = 16, ShowMs = 8000, FadeMs = 140, FadeStepMs = 15, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x80;
    readonly System.Windows.Forms.Timer _timer = new() { Interval = ShowMs };
    readonly System.Windows.Forms.Timer _fade = new() { Interval = FadeStepMs };   // runs only while it fades in
    AlertInfo? _info;
    DateTime _fadeStart;

    /// <summary>Raised when the panel goes away (timeout or click), so the next queued one can show.</summary>
    public event Action? Dismissed;

    public AlertWindow()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        DoubleBuffered = true;
        Opacity = 0;
        Theme.Refresh();
        BackColor = Theme.UseBackdrop ? Color.Black : Theme.Surface(Theme.AppsLight);
        _timer.Tick += (_, _) => Close2();
        _fade.Tick += (_, _) =>
        {
            double t = Math.Min(1, (DateTime.UtcNow - _fadeStart).TotalMilliseconds / FadeMs);
            Opacity = 1 - Math.Pow(1 - t, 3);
            if (t >= 1) _fade.Stop();
        };
        Click += (_, _) => Close2();
    }

    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW; return cp; } }

    int S(int v) => (int)Math.Round(v * DeviceDpi / 96.0);

    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Restyle(); }

    void Restyle()
    {
        if (!IsHandleCreated) return;
        Theme.Refresh();
        BackColor = Theme.UseBackdrop ? Color.Black : Theme.Surface(Theme.AppsLight);
        Native.Style(Handle, !Theme.AppsLight, Native.Corner.Round, Theme.UseBackdrop ? Theme.FlyoutMaterial : null);
    }

    void Close2() { _timer.Stop(); _fade.Stop(); if (Visible) Hide(); Dismissed?.Invoke(); }

    /// <summary>Show next to `anchor` (the corner by the tray, like a Windows toast).</summary>
    public void ShowAlert(AlertInfo info, Rectangle anchor)
    {
        Prepare(info);
        var screen = Screen.FromRectangle(anchor);
        Location = Placement.FlyoutAt(anchor, Size, screen.WorkingArea, S(12));
        _timer.Stop(); _timer.Start();
        if (!Visible) { Restyle(); Opacity = 0; Show(); _fadeStart = DateTime.UtcNow; _fade.Start(); }
        Invalidate();
    }

    /// <summary>Size for this alert, without showing it (also used by --render).</summary>
    public void Prepare(AlertInfo info)
    {
        _info = info;
        using var title = Theme.Body(10.5f, FontStyle.Bold);
        using var body = Theme.Body(9f);
        using var g = CreateGraphics();
        int text = S(WidthPx) - S(Pad) * 2 - S(24) - S(12);
        var th = (int)Math.Ceiling(g.MeasureString(info.Title, title, text).Height);
        var bh = Math.Min((int)Math.Ceiling(g.MeasureString(info.Body, body, text).Height), S(54));
        Size = new Size(S(WidthPx), Math.Max(S(Pad) * 2 + S(24), S(Pad) * 2 + th + S(4) + bh));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (_info == null) return;
        var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        bool light = Theme.AppsLight;
        using var title = Theme.Body(10.5f, FontStyle.Bold);
        using var body = Theme.Body(9f);
        using var t = new SolidBrush(Theme.Text(light)); using var s = new SolidBrush(Theme.Subtle(light));
        int pad = S(Pad), bs = S(24), tx = pad + bs + S(12), tw = Width - tx - pad;
        Badge.Draw(g, _info.Tone, new Rectangle(pad, pad, bs, bs));
        using var fmt = new StringFormat { Trimming = StringTrimming.EllipsisWord };
        var th = (int)Math.Ceiling(g.MeasureString(_info.Title, title, tw).Height);
        g.DrawString(_info.Title, title, t, new RectangleF(tx, pad, tw, th), fmt);
        g.DrawString(_info.Body, body, s, new RectangleF(tx, pad + th + S(4), tw, S(54)), fmt);
    }

    protected override void Dispose(bool disposing) { if (disposing) { _timer.Dispose(); _fade.Dispose(); } base.Dispose(disposing); }
}
