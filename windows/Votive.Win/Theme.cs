using System.Drawing.Text;
using Microsoft.Win32;

namespace Votive.Win;

/// <summary>
/// What the user chose in Windows: light or dark (apps and the taskbar are separate settings), and the
/// fonts Windows 11 itself uses. Read once, and again when Windows says the preference changed (an event,
/// never a timer).
/// </summary>
static class Theme
{
    const string Personalize = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    static string? _text, _display;

    /// <summary>The apps theme: flyouts and alerts follow it.</summary>
    public static bool AppsLight { get; private set; }
    /// <summary>The taskbar theme: a pill sitting inside the taskbar follows this one.</summary>
    public static bool TaskbarLight { get; private set; }

    /// <summary>The material behind flyouts and alerts. Mica is quiet and dark like Windows 11's own surfaces; acrylic is lighter and more see-through.</summary>
    public static Native.Backdrop FlyoutMaterial { get; set; } = Native.Backdrop.Mica;

    /// <summary>False when the window paints its own solid background (no acrylic): older Windows, or --render.</summary>
    public static bool UseBackdrop { get; set; } = Native.HasBackdrop;

    /// <summary>For --render: show one theme whatever Windows is set to.</summary>
    public static bool? Override { get; set; }

    public static void Refresh()
    {
        AppsLight = Override ?? ReadLight("AppsUseLightTheme");
        TaskbarLight = Override ?? ReadLight("SystemUsesLightTheme");
    }

    static bool ReadLight(string name)
    {
        try { using var k = Registry.CurrentUser.OpenSubKey(Personalize); return k?.GetValue(name) is int v && v != 0; }
        catch { return false; }
    }

    // ---- colours (dark first, then light) ----
    public static Color Text(bool light) => light ? Color.FromArgb(28, 28, 28) : Color.FromArgb(255, 255, 255);
    public static Color Subtle(bool light) => light ? Color.FromArgb(96, 96, 96) : Color.FromArgb(178, 178, 178);
    public static Color Hover(bool light) => light ? Color.FromArgb(232, 232, 232) : Color.FromArgb(52, 52, 52);
    public static Color Divider(bool light) => light ? Color.FromArgb(220, 220, 220) : Color.FromArgb(62, 62, 62);
    /// <summary>The solid background, used only when there is no acrylic to show through.</summary>
    public static Color Surface(bool light) => light ? Color.FromArgb(243, 243, 243) : Color.FromArgb(32, 32, 32);
    public static Color Track(bool light) => light ? Color.FromArgb(205, 205, 205) : Color.FromArgb(72, 72, 72);

    /// <summary>The Windows accent colour, for the one place it belongs (focus and the selected row).</summary>
    public static Color Accent()
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\DWM");
            if (k?.GetValue("AccentColor") is int abgr) return Color.FromArgb(abgr & 0xFF, (abgr >> 8) & 0xFF, (abgr >> 16) & 0xFF);
        }
        catch { }
        return Color.FromArgb(0, 120, 212);
    }

    // ---- fonts ----
    static string Pick(string preferred)
    {
        try { using var fonts = new InstalledFontCollection(); return fonts.Families.Any(f => f.Name == preferred) ? preferred : "Segoe UI"; }
        catch { return "Segoe UI"; }
    }

    /// <summary>Body text: Segoe UI Variable Text on Windows 11, Segoe UI before that.</summary>
    public static Font Body(float pt, FontStyle style = FontStyle.Regular) => new(_text ??= Pick("Segoe UI Variable Text"), pt, style, GraphicsUnit.Point);
    /// <summary>Titles: Segoe UI Variable Display.</summary>
    public static Font Title(float pt, FontStyle style = FontStyle.Bold) => new(_display ??= Pick("Segoe UI Variable Display"), pt, style, GraphicsUnit.Point);
}
