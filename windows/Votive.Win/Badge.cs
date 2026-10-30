using System.Drawing.Drawing2D;

namespace Votive.Win;

/// <summary>
/// A small round status badge: the state's colour with a simple white symbol inside, so the meaning is
/// carried by shape as well as colour (the same idea as the ring on the pill, drawn bigger).
/// Painted with vector paths, so it needs no icon font and looks the same on every Windows version.
/// </summary>
static class Badge
{
    public static void Draw(Graphics g, AgentState state, Rectangle r)
    {
        var old = g.SmoothingMode; g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var fill = new SolidBrush(StateResolver.ColorOf(state))) g.FillEllipse(fill, r);
        float w = Math.Max(1.6f, r.Width / 11f);
        using var pen = new Pen(Color.White, w) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        float cx = r.Left + r.Width / 2f, cy = r.Top + r.Height / 2f, u = r.Width / 10f;   // u: a tenth of the badge
        switch (state)
        {
            case AgentState.Done:                       // a tick
                g.DrawLines(pen, new[] { new PointF(cx - 2.6f * u, cy + 0.1f * u), new PointF(cx - 0.7f * u, cy + 2.2f * u), new PointF(cx + 2.8f * u, cy - 2.2f * u) });
                break;
            case AgentState.Warning:                    // an exclamation mark
                g.DrawLine(pen, cx, cy - 2.7f * u, cx, cy + 0.6f * u);
                using (var dot = new SolidBrush(Color.White)) g.FillEllipse(dot, cx - w * 0.6f, cy + 1.9f * u, w * 1.2f, w * 1.2f);
                break;
            case AgentState.NeedsInput:                 // a question mark: it is waiting for you
                using (var q = new GraphicsPath())
                {
                    q.AddArc(cx - 1.9f * u, cy - 3.0f * u, 3.8f * u, 3.6f * u, 200, 250);
                    q.AddLine(cx + 0.1f * u, cy + 0.4f * u, cx, cy + 1.2f * u);
                    g.DrawPath(pen, q);
                }
                using (var dot = new SolidBrush(Color.White)) g.FillEllipse(dot, cx - w * 0.6f, cy + 2.3f * u, w * 1.2f, w * 1.2f);
                break;
            case AgentState.Stuck:                      // clock hands
                g.DrawLines(pen, new[] { new PointF(cx, cy - 2.8f * u), new PointF(cx, cy), new PointF(cx + 2.2f * u, cy + 1.4f * u) });
                break;
            case AgentState.Stopped:                    // a square: stop
                using (var sq = new SolidBrush(Color.White)) g.FillRectangle(sq, cx - 2.2f * u, cy - 2.2f * u, 4.4f * u, 4.4f * u);
                break;
            case AgentState.Working:                    // a turning arc
                g.DrawArc(pen, cx - 2.7f * u, cy - 2.7f * u, 5.4f * u, 5.4f * u, -60, 250);
                break;
            default:                                    // starting: a play triangle
                using (var tri = new SolidBrush(Color.White))
                    g.FillPolygon(tri, new[] { new PointF(cx - 1.6f * u, cy - 2.6f * u), new PointF(cx + 2.8f * u, cy), new PointF(cx - 1.6f * u, cy + 2.6f * u) });
                break;
        }
        g.SmoothingMode = old;
    }
}
