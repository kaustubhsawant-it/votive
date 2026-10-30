using System.Runtime.InteropServices;

namespace Votive.Win;

/// <summary>
/// The few system calls that make the windows look like Windows 11: rounded corners, shadow and acrylic
/// from the compositor, the dark-mode title/border state, and where the taskbar and its tray area are.
/// Everything here only reads window geometry or styles our own windows; nothing reaches into, or
/// sends anything to, another program.
/// </summary>
static class Native
{
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MARGINS { public int Left, Right, Top, Bottom; }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string? title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string? title);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint msg, ref APPBARDATA data);
    [StructLayout(LayoutKind.Sequential)]
    struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam; }

    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWA_BORDER_COLOR = 34, DWMWA_SYSTEMBACKDROP_TYPE = 38;
    const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200, ABM_GETSTATE = 4, ABM_GETTASKBARPOS = 5, ABS_AUTOHIDE = 1;
    static readonly IntPtr HWND_TOPMOST = new(-1);

    /// <summary>Windows 11 (build 22000+) has rounded corners; 22621+ has the system backdrops (acrylic).</summary>
    public static bool HasRoundedCorners => Environment.OSVersion.Version.Build >= 22000;
    public static bool HasBackdrop => Environment.OSVersion.Version.Build >= 22621;

    public enum Corner { Default = 0, None = 1, Round = 2, Small = 3 }
    public enum Backdrop { None = 1, Mica = 2, Acrylic = 3, MicaAlt = 4 }

    /// <summary>
    /// Gives a borderless window the system's own corners, shadow and (when asked for) acrylic. The client
    /// area must then be painted black where the material should show through.
    /// </summary>
    public static void Style(IntPtr hwnd, bool dark, Corner corner, Backdrop? backdrop)
    {
        try
        {
            int v = dark ? 1 : 0;
            DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref v, sizeof(int));
            if (HasRoundedCorners) { int c = (int)corner; DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref c, sizeof(int)); }
            var m = new MARGINS { Left = -1, Right = -1, Top = -1, Bottom = -1 };   // extend the frame over everything: shadow, and the material
            if (backdrop != null && HasBackdrop) { int b = (int)backdrop.Value; DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ref b, sizeof(int)); DwmExtendFrameIntoClientArea(hwnd, ref m); }
            else { var edge = new MARGINS { Left = 1, Right = 1, Top = 1, Bottom = 1 }; DwmExtendFrameIntoClientArea(hwnd, ref edge); }   // 1 px: just the shadow
        }
        catch { /* an older Windows simply keeps the plain look */ }
    }

    /// <summary>Keep a topmost window above the taskbar, which moves itself to the front when clicked.</summary>
    public static void RaiseTopmost(IntPtr hwnd)
    {
        try { SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER); } catch { }
    }

    static Rectangle? RectOf(IntPtr h) => h != IntPtr.Zero && GetWindowRect(h, out var r) && r.Right > r.Left && r.Bottom > r.Top
        ? Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom) : null;

    /// <summary>The taskbar's rectangle and its notification area (clock, tray icons), when the shell has them.</summary>
    public static (Rectangle? Taskbar, Rectangle? Tray) TaskbarGeometry()
    {
        try
        {
            var bar = FindWindow("Shell_TrayWnd", null);
            return (RectOf(bar), bar == IntPtr.Zero ? null : RectOf(FindWindowEx(bar, IntPtr.Zero, "TrayNotifyWnd", null)));
        }
        catch { return (null, null); }
    }

    public static bool TaskbarAutoHides()
    {
        try { var d = new APPBARDATA { cbSize = Marshal.SizeOf<APPBARDATA>() }; return ((uint)SHAppBarMessage(ABM_GETSTATE, ref d) & ABS_AUTOHIDE) != 0; }
        catch { return false; }
    }
}
