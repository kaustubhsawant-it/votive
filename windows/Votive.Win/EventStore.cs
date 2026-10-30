using System.Text.Json;

namespace Votive.Win;

public sealed record SessionEntry(string Agent, string SessionId, string Project, string LastEvent, long LastEventAt, int Pid, string? Prompt = null, string? Detail = null, string? NotifyMessage = null, long? NotifyAt = null);

/// <summary>
/// Reads the small JSON files the hooks write to ~/.votive/events. Tolerant by design: a
/// missing folder is "no sessions", and a half-written, oversized or foreign file is skipped.
/// </summary>
public static class EventStore
{
    const int MaxFileBytes = 64 * 1024;
    const long MaxPlausibleMs = 4_102_444_800_000;   // year 2100, same bound as the macOS app

    /// <summary>~/.votive, or $VOTIVE_HOME for tests and demos.</summary>
    public static string Root()
    {
        var home = Environment.GetEnvironmentVariable("VOTIVE_HOME");
        return string.IsNullOrWhiteSpace(home)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".votive")
            : home;
    }

    public static string EventsDir() => Path.Combine(Root(), "events");

    public static List<SessionEntry> Scan(string dir)
    {
        var list = new List<SessionEntry>();
        string[] files;
        try { files = Directory.GetFiles(dir, "*.json"); } catch { return list; }
        foreach (var f in files)
        {
            var e = Read(f);
            if (e != null) list.Add(e);
        }
        return list;
    }

    static SessionEntry? Read(string path)
    {
        // Share Read|Write|Delete: the hook replaces the file by renaming over it.
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                if (fs.Length > MaxFileBytes) return null;
                using var doc = JsonDocument.Parse(fs);
                return Parse(doc.RootElement);
            }
            catch (IOException) { Thread.Sleep(15); }          // being replaced right now
            catch (JsonException) { return null; }             // half-written or not ours
            catch { return null; }
        }
        return null;
    }

    public static SessionEntry? Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return null;
        string? Str(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var agent = Str("agent");
        var session = Str("sessionId");
        var last = Str("lastEvent");
        if (string.IsNullOrEmpty(agent) || string.IsNullOrEmpty(session) || string.IsNullOrEmpty(last)) return null;
        if (!root.TryGetProperty("lastEventAt", out var at) || at.ValueKind != JsonValueKind.Number || !at.TryGetInt64(out var atMs) || atMs < 0 || atMs > MaxPlausibleMs) return null;
        int pid = root.TryGetProperty("pid", out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out var pv) && pv > 1 ? pv : 0;
        var cwd = Str("cwd");
        var project = string.IsNullOrEmpty(cwd) ? agent! : Path.GetFileName(cwd.TrimEnd('\\', '/'));
        if (string.IsNullOrEmpty(project)) project = agent!;
        var prompt = Str("prompt");
        var detail = Str("waitReason") ?? Str("detail");
        var notify = Str("notifyMessage");
        long? notifyAt = root.TryGetProperty("notifyAt", out var na) && na.ValueKind == JsonValueKind.Number && na.TryGetInt64(out var nav) && nav >= 0 && nav <= MaxPlausibleMs ? nav : null;
        return new SessionEntry(Clip(agent!, 40), Clip(session!, 80), Clip(project, 40), last!, atMs, pid,
            string.IsNullOrWhiteSpace(prompt) ? null : Clip(prompt!, 160), string.IsNullOrWhiteSpace(detail) ? null : Clip(detail!, 100),
            string.IsNullOrWhiteSpace(notify) || notifyAt == null ? null : Clip(notify!, 300), notifyAt);
    }

    static string Clip(string s, int max)
    {
        var clean = new string(s.Where(c => !char.IsControl(c)).ToArray());
        return clean.Length <= max ? clean : clean[..max];
    }

    /// <summary>True/false when the pid is known to run or not; null when no pid was recorded.</summary>
    public static bool? IsAlive(int pid)
    {
        if (pid <= 1) return null;
        try { using var p = System.Diagnostics.Process.GetProcessById(pid); return !p.HasExited; }
        catch (ArgumentException) { return false; }
        catch { return null; }
    }
}
