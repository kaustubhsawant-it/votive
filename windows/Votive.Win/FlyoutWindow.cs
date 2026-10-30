using System.ComponentModel;
using System.Drawing.Drawing2D;
using System.Drawing.Text;

namespace Votive.Win;

/// <summary>
/// The expanded list, in the style of a Windows 11 flyout: acrylic, system corners and shadow, Segoe UI
/// Variable, a status badge per session, a hover row, and arrow-key navigation. It opens next to the pill (or
/// the tray icon), fades in, and closes on a click anywhere else or Esc. Read-only on purpose: it never
/// reaches into another program.
/// </summary>
public sealed class FlyoutWindow : Form
{
    const int WidthPx = 380, Row = 56, Header = 46, Pad = 16, MaxRows = 9, FadeMs = 130, FadeStepMs = 15, WS_EX_TOOLWINDOW = 0x80;

    readonly System.Windows.Forms.Timer _fade = new() { Interval = FadeStepMs };   // runs only while the flyout fades in
    List<(AgentState State, SessionEntry Entry)> _rows = new();
    UsageSummary? _usage;
    long _now;
    int _hover = -1;

    /// <summary>--demo-open only: stay open when focus is elsewhere, so a screenshot can catch it.</summary>
    [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public bool StayOpen { get; set; }
    DateTime _fadeStart;

    public FlyoutWindow()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        DoubleBuffered = true;
        KeyPreview = true;
        Opacity = 0;
        Theme.Refresh();
        BackColor = Theme.UseBackdrop ? Color.Black : Theme.Surface(Theme.AppsLight);
        KeyDown += OnKey;
        Deactivate += (_, _) => { if (!StayOpen) Hide(); };      // click anywhere else closes it
        _fade.Tick += (_, _) =>
        {
            double t = Math.Min(1, (DateTime.UtcNow - _fadeStart).TotalMilliseconds / FadeMs);
            Opacity = 1 - Math.Pow(1 - t, 3);   // ease out
            if (t >= 1) _fade.Stop();
        };
    }

    protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= WS_EX_TOOLWINDOW; return cp; } }

    int S(int v) => (int)Math.Round(v * DeviceDpi / 96.0);

    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Restyle(); }

    void Restyle()
    {
        if (!IsHandleCreated) return;
        Theme.Refresh();
        BackColor = Theme.UseBackdrop ? Color.Black : Theme.Surface(Theme.AppsLight);
        Native.Style(Handle, !Theme.AppsLight, Native.Corner.Round, Theme.UseBackdrop ? Theme.FlyoutMaterial : null);
    }

    /// <summary>Show next to `anchor`, or refresh in place when already open.</summary>
    public void ShowAt(List<(AgentState State, SessionEntry Entry)> rows, UsageSummary? usage, Rectangle anchor, long nowMs)
    {
        Update(rows, usage, nowMs);
        var screen = Screen.FromRectangle(anchor);
        Location = Placement.FlyoutAt(anchor, Size, screen.WorkingArea, S(10));
        if (!Visible)
        {
            Restyle();
            _hover = -1;
            Opacity = 0; Show(); Activate();
            _fadeStart = DateTime.UtcNow; _fade.Start();
        }
    }

    public void Update(List<(AgentState State, SessionEntry Entry)> rows, UsageSummary? usage, long nowMs)
    {
        _rows = rows; _usage = usage; _now = nowMs;
        _hover = Math.Min(_hover, Math.Min(rows.Count, MaxRows) - 1);
        int shown = Math.Min(rows.Count, MaxRows);
        int h = S(Header) + Math.Max(1, shown) * S(Row) + (rows.Count > shown ? S(28) : 0) + UsageHeight() + S(10);
        Size = new Size(S(WidthPx), h);
        Invalidate();
    }

    int UsageHeight() => _usage == null || _usage.Windows.Count == 0 ? 0 : S(18) + _usage.Windows.Count * S(30) + S(8);

    // ---- mouse and keys ----
    int RowAt(Point p)
    {
        int top = S(Header), n = Math.Min(_rows.Count, MaxRows);
        if (p.Y < top || p.Y >= top + n * S(Row)) return -1;
        return (p.Y - top) / S(Row);
    }

    protected override void OnMouseMove(MouseEventArgs e) { var r = RowAt(e.Location); if (r != _hover) { _hover = r; Invalidate(); } base.OnMouseMove(e); }
    protected override void OnMouseLeave(EventArgs e) { if (_hover != -1) { _hover = -1; Invalidate(); } base.OnMouseLeave(e); }

    void OnKey(object? sender, KeyEventArgs e)
    {
        int n = Math.Min(_rows.Count, MaxRows);
        if (e.KeyCode == Keys.Escape) { Hide(); e.Handled = true; }
        else if (e.KeyCode == Keys.Down && n > 0) { _hover = (_hover + 1) % n; Invalidate(); e.Handled = true; }
        else if (e.KeyCode == Keys.Up && n > 0) { _hover = _hover <= 0 ? n - 1 : _hover - 1; Invalidate(); e.Handled = true; }
    }

    // ---- painting ----
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        bool light = Theme.AppsLight;
        Color text = Theme.Text(light), subtle = Theme.Subtle(light);
        int pad = S(Pad), width = Width;
        using var title = Theme.Title(13f);
        using var name = Theme.Body(10.5f, FontStyle.Bold);
        using var body = Theme.Body(9f);
        using var small = Theme.Body(8.5f);
        using var left = new StringFormat(StringFormatFlags.NoWrap) { Trimming = StringTrimming.EllipsisCharacter, LineAlignment = StringAlignment.Center };
        using var right = new StringFormat(StringFormatFlags.NoWrap) { Alignment = StringAlignment.Far, LineAlignment = StringAlignment.Center };
        using var t = new SolidBrush(text); using var s = new SolidBrush(subtle);

        // header
        g.DrawString("Votive", title, t, new RectangleF(pad, S(8), width - pad * 2, S(30)), left);
        var count = _rows.Count == 0 ? "no sessions" : _rows.Count + (_rows.Count == 1 ? " session" : " sessions");
        g.DrawString(count, small, s, new RectangleF(pad, S(8), width - pad * 2, S(30)), right);

        int y = S(Header), shown = Math.Min(_rows.Count, MaxRows), rowH = S(Row);
        if (_rows.Count == 0)
        {
            g.DrawString("Nothing is running. Sessions appear here as agents start.", body, s, new RectangleF(pad, y, width - pad * 2, rowH), left);
            y += rowH;
        }
        for (int i = 0; i < shown; i++)
        {
            var (state, en) = _rows[i];
            int top = y + i * rowH;
            var hit = new Rectangle(S(6), top + S(2), width - S(12), rowH - S(4));
            if (i == _hover)
            {
                using var path = RoundRect(hit, S(6));
                using var hv = new SolidBrush(Theme.Hover(light));
                g.FillPath(hv, path);
                using var accent = new SolidBrush(Theme.Accent());
                g.FillRectangle(accent, hit.Left, top + rowH / 2 - S(8), S(3), S(16));   // the selection bar, in the user's accent colour
            }
            int bs = S(24);
            Badge.Draw(g, state, new Rectangle(pad + S(2), top + (rowH - bs) / 2, bs, bs));
            int tx = pad + S(2) + bs + S(12), tw = width - tx - pad;
            var meta = $"{StateResolver.Label(state)} · {Format.Ago(en.LastEventAt, _now)}";
            var metaWidth = (int)g.MeasureString(meta, small).Width + S(4);
            using (var mb = new SolidBrush(StateResolver.ColorOf(state))) g.DrawString(meta, small, light ? s : mb, new RectangleF(width - pad - metaWidth, top + S(8), metaWidth, S(18)), right);
            g.DrawString(en.Project, name, t, new RectangleF(tx, top + S(7), tw - metaWidth - S(6), S(20)), left);
            var sub = en.Detail != null && state == AgentState.NeedsInput ? "Wants: " + en.Detail : en.Prompt ?? en.Agent;
            g.DrawString(sub, small, s, new RectangleF(tx, top + S(29), tw, S(18)), left);
        }
        y += Math.Max(1, shown) * rowH;
        if (_rows.Count > shown) { g.DrawString($"+{_rows.Count - shown} more", small, s, new RectangleF(pad, y + S(2), width - pad * 2, S(22)), left); y += S(28); }

        if (UsageHeight() > 0 && _usage != null)
        {
            using var line = new Pen(Theme.Divider(light));
            g.DrawLine(line, pad, y + S(2), width - pad, y + S(2));
            y += S(14);
            foreach (var w in _usage.Windows)
            {
                g.DrawString($"{w.Label}  {w.Percent}%", small, t, new RectangleF(pad, y, S(150), S(22)), left);
                var reset = w.ResetsInMs is { } rm ? "resets in " + Format.Duration(rm) : "";
                var rw = (int)g.MeasureString(reset, small).Width + S(4);
                g.DrawString(reset, small, s, new RectangleF(width - pad - rw, y, rw, S(22)), right);
                int bx = pad + S(150), bw = width - pad * 2 - S(150) - rw - S(10), by = y + S(8);
                if (bw > S(30))
                {
                    using (var tp = RoundRect(new Rectangle(bx, by, bw, S(6)), S(3))) using (var tb = new SolidBrush(Theme.Track(light))) g.FillPath(tb, tp);
                    var col = w.Percent >= 90 ? Color.FromArgb(255, 69, 58) : w.Percent >= 70 ? Color.FromArgb(255, 159, 10) : Color.FromArgb(48, 209, 88);
                    int fw = Math.Max(S(6), (int)(bw * Math.Min(100, w.Percent) / 100.0));
                    using (var fp = RoundRect(new Rectangle(bx, by, fw, S(6)), S(3))) using (var fb = new SolidBrush(col)) g.FillPath(fb, fp);
                }
                y += S(30);
            }
        }
    }

    static GraphicsPath RoundRect(Rectangle r, int radius)
    {
        int d = Math.Max(1, radius * 2);
        var p = new GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure(); return p;
    }

    protected override void Dispose(bool disposing) { if (disposing) _fade.Dispose(); base.Dispose(disposing); }
}
