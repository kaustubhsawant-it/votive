using System.Runtime.InteropServices;

namespace Votive.Win;

/// <summary>Where the pill lives. The tray icon is always there; "TrayOnly" simply hides the pill.</summary>
public enum PillMode { Top, Taskbar, Custom, TrayOnly }
public enum TaskbarEdge { Left, Top, Right, Bottom }   // same order as Windows' ABE_* values

public static class Placement
{
    public static PillMode ParseMode(string? s) => s switch
    {
        "taskbar" => PillMode.Taskbar, "custom" => PillMode.Custom, "tray" => PillMode.TrayOnly, _ => PillMode.Top,
    };

    public static string ModeName(PillMode m) => m switch
    {
        PillMode.Taskbar => "taskbar", PillMode.Custom => "custom", PillMode.TrayOnly => "tray", _ => "top",
    };

    /// <summary>
    /// The pill's top-left corner, or null when it should not be shown. Pure: everything it needs is
    /// passed in, so it is checked in --self-test without a display. `dpi` scales the margins.
    /// Top: centred under the top edge. Taskbar: inside the taskbar, left of the tray (or the corner beside it when
    /// the taskbar is auto-hidden or vertical). Custom: where the user dragged it, kept on screen.
    /// </summary>
    public static Point? Compute(PillMode mode, Rectangle bounds, Rectangle work, Size pill, TaskbarEdge edge, Size taskbar, int dpi, Point? custom,
        Rectangle? taskbarRect = null, Rectangle? trayRect = null, bool autoHide = false)
    {
        int S(int v) => (int)Math.Round(v * dpi / 96.0);
        int margin = S(8), corner = S(16), normalBar = S(48);
        switch (mode)
        {
            case PillMode.TrayOnly:
                return null;
            case PillMode.Custom when custom is { } c:
                return new Point(Math.Clamp(c.X, bounds.Left, Math.Max(bounds.Left, bounds.Right - pill.Width)),
                                 Math.Clamp(c.Y, bounds.Top, Math.Max(bounds.Top, bounds.Bottom - pill.Height)));
            case PillMode.Taskbar:
            {
                // Inside a horizontal taskbar, just left of the notification area, centred in its height.
                // An auto-hidden taskbar is off screen most of the time and a vertical one is too narrow
                // for a horizontal pill, so those fall back to the corner beside where the taskbar is.
                if (!autoHide && taskbarRect is { } bar && edge is TaskbarEdge.Bottom or TaskbarEdge.Top && bar.Height >= pill.Height + S(4))
                {
                    int right = trayRect is { } tray && tray.Left > bar.Left && tray.Left < bar.Right ? tray.Left : bar.Right - S(220);
                    int x = Math.Max(bar.Left, right - pill.Width - S(8));
                    return new Point(x, bar.Top + (bar.Height - pill.Height) / 2);
                }
                int reserveY = Math.Max(taskbar.Height, normalBar), reserveX = Math.Max(taskbar.Width, normalBar);
                return edge switch
                {
                    TaskbarEdge.Top => new Point(bounds.Right - pill.Width - corner, bounds.Top + reserveY + margin),
                    TaskbarEdge.Left => new Point(bounds.Left + reserveX + margin, bounds.Bottom - pill.Height - corner),
                    TaskbarEdge.Right => new Point(bounds.Right - reserveX - pill.Width - margin, bounds.Bottom - pill.Height - corner),
                    _ => new Point(bounds.Right - pill.Width - corner, bounds.Bottom - reserveY - pill.Height - margin),
                };
            }
            default:   // Top, and Custom with nothing saved yet
                return new Point(work.Left + (work.Width - pill.Width) / 2, work.Top + margin);
        }
    }

    /// <summary>
    /// Where a flyout of `size` opens next to `anchor` (the pill or the tray click): below it when the
    /// anchor is in the top half of the screen, above it otherwise, centred on it and kept on screen.
    /// </summary>
    public static Point FlyoutAt(Rectangle anchor, Size size, Rectangle bounds, int gap)
    {
        bool below = anchor.Top + anchor.Height / 2 < bounds.Top + bounds.Height / 2;
        int x = anchor.Left + anchor.Width / 2 - size.Width / 2;
        int y = below ? anchor.Bottom + gap : anchor.Top - size.Height - gap;
        x = Math.Clamp(x, bounds.Left + gap, Math.Max(bounds.Left + gap, bounds.Right - size.Width - gap));
        y = Math.Clamp(y, bounds.Top + gap, Math.Max(bounds.Top + gap, bounds.Bottom - size.Height - gap));
        return new Point(x, y);
    }

    /// <summary>
    /// The visible taskbar, found as the strip Windows leaves out of the work area. (The taskbar's window
    /// is taller than the bar you see, so its own rectangle cannot be used to centre anything in it.)
    /// Null when nothing is left out: no taskbar, or one that auto-hides.
    /// </summary>
    public static (TaskbarEdge Edge, Rectangle Bar)? VisibleBar(Rectangle bounds, Rectangle work)
    {
        if (work.Bottom < bounds.Bottom) return (TaskbarEdge.Bottom, Rectangle.FromLTRB(bounds.Left, work.Bottom, bounds.Right, bounds.Bottom));
        if (work.Top > bounds.Top) return (TaskbarEdge.Top, Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, work.Top));
        if (work.Left > bounds.Left) return (TaskbarEdge.Left, Rectangle.FromLTRB(bounds.Left, bounds.Top, work.Left, bounds.Bottom));
        if (work.Right < bounds.Right) return (TaskbarEdge.Right, Rectangle.FromLTRB(work.Right, bounds.Top, bounds.Right, bounds.Bottom));
        return null;
    }

    // ---- where the taskbar is (read-only query of the shell) ----
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam; }
    [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);
    const uint ABM_GETTASKBARPOS = 5;

    /// <summary>The taskbar's edge and size, or a bottom taskbar of unknown size when the shell does not say.</summary>
    public static (TaskbarEdge Edge, Size Size) QueryTaskbar()
    {
        try
        {
            var d = new APPBARDATA { cbSize = Marshal.SizeOf<APPBARDATA>() };
            if (SHAppBarMessage(ABM_GETTASKBARPOS, ref d) != UIntPtr.Zero && d.uEdge <= 3)
                return ((TaskbarEdge)d.uEdge, new Size(Math.Max(0, d.rc.Right - d.rc.Left), Math.Max(0, d.rc.Bottom - d.rc.Top)));
        }
        catch { /* fall through */ }
        return (TaskbarEdge.Bottom, Size.Empty);
    }
}
