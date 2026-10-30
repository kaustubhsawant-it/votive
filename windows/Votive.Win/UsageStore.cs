using System.Text.Json;

namespace Votive.Win;

public sealed record UsageWindow(string Label, int Percent, long? ResetsInMs);
public sealed record UsageSummary(List<UsageWindow> Windows)
{
    /// <summary>Same alert line as the macOS app: strictly above 70% in any window.</summary>
    public const int AlertAbove = 70;
    public int Highest => Windows.Count == 0 ? 0 : Windows.Max(w => w.Percent);
    public bool OverThreshold => Highest > AlertAbove;
}

/// <summary>
/// Plan usage the status-line hook records in ~/.votive/usage/&lt;agent&gt;.json. Read-only and tolerant:
/// a window whose reset time has passed is dropped (a stale 90% must never keep an alert on), values
/// outside 0..100 are ignored, and a file that is not ours reads as nothing.
/// </summary>
public static class UsageStore
{
    const int MaxFileBytes = 64 * 1024;

    public static string UsageDir() => Path.Combine(EventStore.Root(), "usage");

    static string AgentName(string agent) => agent switch { "claude-code" => "Claude", "codex" => "Codex", _ => agent.Length == 0 ? "Agent" : char.ToUpperInvariant(agent[0]) + agent[1..] };

    /// <summary>Windows from one usage file's text. `nowMs` decides which resets are already past.</summary>
    public static List<UsageWindow> Parse(string json, long nowMs)
    {
        var list = new List<UsageWindow>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("windows", out var ws) || ws.ValueKind != JsonValueKind.Array) return list;
            foreach (var w in ws.EnumerateArray())
            {
                if (w.ValueKind != JsonValueKind.Object) continue;
                if (!w.TryGetProperty("label", out var l) || l.ValueKind != JsonValueKind.String) continue;
                if (!w.TryGetProperty("usedPercentage", out var p) || p.ValueKind != JsonValueKind.Number || !p.TryGetDouble(out var pct)) continue;
                if (double.IsNaN(pct) || pct < 0 || pct > 100) continue;
                long? resetMs = null;
                if (w.TryGetProperty("resetsAt", out var r) && r.ValueKind == JsonValueKind.Number && r.TryGetInt64(out var sec))
                {
                    if (sec <= 1_000_000_000 || sec >= 4_000_000_000) continue;     // not a plausible epoch-seconds time
                    resetMs = sec * 1000 - nowMs;
                    if (resetMs <= 0) continue;                                     // already reset
                }
                var label = new string((l.GetString() ?? "").Where(c => !char.IsControl(c)).ToArray());
                if (label.Length == 0) continue;
                list.Add(new UsageWindow(label.Length > 24 ? label[..24] : label, (int)Math.Floor(pct), resetMs));
            }
        }
        catch { list.Clear(); }
        return list;
    }

    /// <summary>Every agent's usage, or null when none is recorded. With several agents, labels carry the agent's name.</summary>
    public static UsageSummary? Scan(string dir, long nowMs)
    {
        var perAgent = new List<(string Agent, List<UsageWindow> Windows)>();
        string[] files;
        try { files = Directory.GetFiles(dir, "*.json"); } catch { return null; }
        foreach (var f in files.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var fi = new FileInfo(f);
                if (fi.Length > MaxFileBytes) continue;
                using var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var rd = new StreamReader(fs);
                var ws = Parse(rd.ReadToEnd(), nowMs);
                if (ws.Count > 0) perAgent.Add((Path.GetFileNameWithoutExtension(f), ws));
            }
            catch { /* skip unreadable */ }
        }
        if (perAgent.Count == 0) return null;
        bool several = perAgent.Count > 1;
        return new UsageSummary(perAgent.SelectMany(a => a.Windows.Select(w => several ? w with { Label = AgentName(a.Agent) + " " + w.Label } : w)).ToList());
    }
}
