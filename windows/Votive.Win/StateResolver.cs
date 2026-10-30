namespace Votive.Win;

/// <summary>The visual states, same vocabulary and order as the macOS app (AgentState.swift).</summary>
public enum AgentState { Starting, Working, Done, NeedsInput, Warning, Stuck, Stopped }

public static class StateResolver
{
    public const int DefaultStuckMinutes = 8;

    /// <summary>
    /// Turns what the hook recorded into what the user sees. A process that is gone is "stopped";
    /// otherwise the last event decides, and work with no news for the threshold is "stuck".
    /// Anything unknown reads as done, never as an alarm.
    /// </summary>
    public static AgentState Resolve(string? lastEvent, long lastEventAtMs, long nowMs, bool? processAlive, int stuckMinutes = DefaultStuckMinutes)
    {
        if (processAlive == false) return AgentState.Stopped;
        switch (lastEvent)
        {
            case "waiting": return AgentState.NeedsInput;
            case "error": return AgentState.Warning;
            case "starting": return AgentState.Starting;
            case "working":
                return stuckMinutes > 0 && nowMs - lastEventAtMs > stuckMinutes * 60_000L ? AgentState.Stuck : AgentState.Working;
            default: return AgentState.Done;
        }
    }

    /// <summary>Lower sorts first: needs-you, error, stuck, stopped, working, starting, done.</summary>
    public static int Priority(AgentState s) => s switch
    {
        AgentState.NeedsInput => 0, AgentState.Warning => 1, AgentState.Stuck => 2, AgentState.Stopped => 3,
        AgentState.Working => 4, AgentState.Starting => 5, _ => 6,
    };

    public static string Label(AgentState s) => s switch
    {
        AgentState.Starting => "starting", AgentState.Working => "working", AgentState.Done => "done",
        AgentState.NeedsInput => "needs you", AgentState.Warning => "error", AgentState.Stuck => "stuck", _ => "stopped",
    };

    /// <summary>Attention states want a look; the rest stay still.</summary>
    public static bool WantsAttention(AgentState s) => s is AgentState.NeedsInput or AgentState.Warning or AgentState.Stuck;

    public static Color ColorOf(AgentState s) => s switch
    {
        AgentState.Starting => Color.FromArgb(10, 132, 255),
        AgentState.Working => Color.FromArgb(255, 214, 10),
        AgentState.Done => Color.FromArgb(48, 209, 88),
        AgentState.NeedsInput => Color.FromArgb(191, 90, 242),
        AgentState.Warning => Color.FromArgb(255, 159, 10),
        AgentState.Stuck => Color.FromArgb(172, 142, 104),
        _ => Color.FromArgb(255, 69, 58),
    };
}
