using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Votive.Win;

/// <summary>
/// Every preference the Windows app reads. Key names are the same ones the Node settings tool and the
/// MCP `settings` tool already use (see Scripts/overlay-settings.js), so changing a setting from an
/// agent works here too. Defaults match the macOS app.
/// </summary>
public sealed record AppSettings(
    PillMode Mode, Point? Custom,
    bool PopupAlerts = false, bool CustomNotify = true, bool Sounds = true, bool UsageAlert = true, int StuckMinutes = 8,
    string SoundNotify = "Glass", string SoundNeedsYou = "none", string SoundError = "none",
    string SoundStuck = "none", string SoundStopped = "none", string SoundDone = "none")
{
    public static readonly AppSettings Default = new(PillMode.Top, null);
}

/// <summary>
/// Preferences live in ~/.votive/settings.json next to the other shared state. Reads are
/// tolerant: anything wrong falls back to the default. Writes keep every other key and are atomic.
/// </summary>
public static class SettingsStore
{
    const int MaxBytes = 64 * 1024, MaxCoord = 32000;
    static readonly Regex SoundName = new(@"^[A-Za-z0-9 _.()\-]{1,64}$", RegexOptions.Compiled);

    public static string FilePath() => Path.Combine(EventStore.Root(), "settings.json");

    public static AppSettings Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || json.Length > MaxBytes) return AppSettings.Default;
        try
        {
            if (JsonNode.Parse(json) is not JsonObject o) return AppSettings.Default;
            var d = AppSettings.Default;
            string? Str(string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
            bool Bool(string k, bool dflt) => o[k] is JsonValue v && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False ? v.GetValue<bool>() : dflt;
            int? Int(string k, int lo, int hi) => o[k] is JsonValue v && v.GetValueKind() == JsonValueKind.Number && v.TryGetValue<int>(out var n) && n >= lo && n <= hi ? n : null;
            string Sound(string k, string dflt) => Str(k) is { } s && SoundName.IsMatch(s) ? s : dflt;
            int? x = Int("pillX", -MaxCoord, MaxCoord), y = Int("pillY", -MaxCoord, MaxCoord);
            return new AppSettings(Placement.ParseMode(Str("pillPosition")), x is { } px && y is { } py ? new Point(px, py) : null,
                Bool("dialogAlertsOn", d.PopupAlerts), Bool("customNotifyOn", d.CustomNotify), Bool("soundsOn", d.Sounds), Bool("usageAlertOn", d.UsageAlert),
                Int("stuckThresholdMinutes", 0, 240) ?? d.StuckMinutes,
                Sound("soundNotify", d.SoundNotify), Sound("soundNeedsYou", d.SoundNeedsYou), Sound("soundError", d.SoundError),
                Sound("soundStuck", d.SoundStuck), Sound("soundStopped", d.SoundStopped), Sound("soundDone", d.SoundDone));
        }
        catch { return AppSettings.Default; }
    }

    public static AppSettings Load(string? path = null)
    {
        try
        {
            var f = new FileInfo(path ?? FilePath());
            if (!f.Exists || f.Length > MaxBytes) return AppSettings.Default;
            using var fs = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var r = new StreamReader(fs);
            return Parse(r.ReadToEnd());
        }
        catch { return AppSettings.Default; }
    }

    /// <summary>Applies `edit` to the file's JSON object, keeping every other key, then replaces the file atomically.</summary>
    public static void Update(Action<JsonObject> edit, string? path = null)
    {
        var file = path ?? FilePath();
        JsonObject o;
        try { o = (File.Exists(file) && new FileInfo(file).Length <= MaxBytes ? JsonNode.Parse(File.ReadAllText(file)) as JsonObject : null) ?? new JsonObject(); }
        catch { o = new JsonObject(); }
        edit(o);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var tmp = file + "." + Environment.ProcessId + ".tmp";
        File.WriteAllText(tmp, o.ToJsonString());
        File.Move(tmp, file, overwrite: true);
    }

    /// <summary>Saves the position choice (and the dragged spot when given).</summary>
    public static void Save(PillMode mode, Point? custom, string? path = null) => Update(o =>
    {
        o["pillPosition"] = Placement.ModeName(mode);
        if (custom is { } c) { o["pillX"] = c.X; o["pillY"] = c.Y; }
    }, path);

    public static void SetBool(string key, bool value, string? path = null) => Update(o => o[key] = value, path);
    public static void SetInt(string key, int value, string? path = null) => Update(o => o[key] = value, path);

    /// <summary>
    /// A switch only the user flips (the tray menu writes it; the MCP tools only read it). On only when the file says
    /// exactly `true`: a missing, malformed, oversized or wrongly typed file reads as off.
    /// </summary>
    public static bool GetBool(string key, string? path = null)
    {
        try
        {
            var f = new FileInfo(path ?? FilePath());
            if (!f.Exists || f.Length > MaxBytes) return false;
            using var fs = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var r = new StreamReader(fs);
            return JsonNode.Parse(r.ReadToEnd()) is JsonObject o && o[key] is JsonValue v && v.GetValueKind() == JsonValueKind.True;
        }
        catch { return false; }
    }
}
