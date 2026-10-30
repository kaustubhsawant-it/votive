namespace Votive.Win;

// The pure logic behind the native taskbar button (AGEN-46): which icon, badge and progress the
// button shows, how the hover card is laid out, and what a click on the button does. No window,
// no Windows API: everything here is checked by `--self-test` without a display.

public enum BadgeKind { None, NeedsYou, Error, Stuck, Stopped }
public enum ProgressKind { None, Normal, Error, Paused }
public enum HostAction { Pass, OpenList }

public sealed record TaskbarButtonState(AgentState Worst, bool Any, BadgeKind Badge, int BadgeCount, ProgressKind Progress, int ProgressPercent, string Tooltip);

public sealed record HoverLayout(int Width, int Height, int VisibleRows, int Overflow, int Pad, int HeaderHeight, int RowHeight);

public static class TaskbarModel
{
    const int MaxBadge = 99;

    /// <summary>
    /// What the one taskbar button shows for all sessions: the worst state decides the icon and the badge, the
    /// progress bar is red for an error or a stopped session, yellow while something needs you or is stuck, and
    /// otherwise the plan usage if there is one.
    /// </summary>
    public static TaskbarButtonState Summarize(IReadOnlyList<AgentState> states, int? usagePercent)
    {
        if (states.Count == 0) return new(AgentState.Done, false, BadgeKind.None, 0, ProgressKind.None, 0, "No agent sessions");
        var worst = states.OrderBy(StateResolver.Priority).First();
        int Count(AgentState s) => states.Count(x => x == s);
        var badge = worst switch
        {
            AgentState.NeedsInput => BadgeKind.NeedsYou, AgentState.Warning => BadgeKind.Error,
            AgentState.Stuck => BadgeKind.Stuck, AgentState.Stopped => BadgeKind.Stopped, _ => BadgeKind.None,
        };
        int badgeCount = badge == BadgeKind.None ? 0 : Math.Min(MaxBadge, Count(worst));
        ProgressKind progress; int percent;
        if (Count(AgentState.Warning) + Count(AgentState.Stopped) > 0) { progress = ProgressKind.Error; percent = 100; }
        else if (Count(AgentState.NeedsInput) + Count(AgentState.Stuck) > 0) { progress = ProgressKind.Paused; percent = 100; }
        else if (usagePercent is { } u) { progress = ProgressKind.Normal; percent = Math.Clamp(u, 0, 100); }
        else { progress = ProgressKind.None; percent = 0; }
        var tip = new List<string> { states.Count + (states.Count == 1 ? " session" : " sessions") };
        foreach (var (s, label) in new[] { (AgentState.NeedsInput, "need you"), (AgentState.Warning, "error"), (AgentState.Stuck, "stuck"), (AgentState.Stopped, "stopped") })
            if (Count(s) > 0) tip.Add(Count(s) + " " + label);
        return new(worst, true, badge, badgeCount, progress, percent, string.Join(", ", tip));
    }
}

public static class HoverCard
{
    // Regular metrics for a roomy area (the list); compact metrics for the small thumbnail Windows offers (200x105 on the
    // 2026-10-20 test PC). Below RoomyHeight the compact metrics are used so that rows still fit.
    public const int Pad = 8, HeaderHeight = 36, RowHeight = 30, MaxWidth = 360, RoomyHeight = 200;
    const int CompactPad = 4, CompactHeader = 24, CompactRow = 20;

    /// <summary>
    /// The hover card is a picture we hand to Windows, which tells us the largest size it will show. Rows that do
    /// not fit are replaced by one "+N more" row; with no sessions there is one "nothing running" row.
    /// </summary>
    public static HoverLayout Layout(int sessions, int maxWidth, int maxHeight)
    {
        bool roomy = maxHeight >= RoomyHeight;
        int pad = roomy ? Pad : CompactPad, header = roomy ? HeaderHeight : CompactHeader, row = roomy ? RowHeight : CompactRow;
        int width = Math.Clamp(maxWidth, 0, MaxWidth), chrome = 2 * pad + header;
        int capacity = Math.Max(0, (maxHeight - chrome) / row);
        int visible, overflow, rows;
        if (sessions <= capacity) { visible = sessions; overflow = 0; rows = Math.Max(1, sessions); }
        else { visible = Math.Max(0, capacity - 1); overflow = sessions - visible; rows = visible + 1; }
        return new(width, Math.Min(chrome + rows * row, Math.Max(0, maxHeight)), visible, overflow, pad, header, row);
    }
}

public static class ClickPolicy
{
    const int SC_MAXIMIZE = 0xF030, SC_RESTORE = 0xF120;

    /// <summary>
    /// A click on the button asks the host window to restore. We never let it: the host stays minimised, and our
    /// own list opens instead. The low four bits of a system command are used by Windows, so they are masked off.
    /// </summary>
    public static HostAction Decide(int sysCommand) => (sysCommand & 0xFFF0) is SC_RESTORE or SC_MAXIMIZE ? HostAction.OpenList : HostAction.Pass;
}
