using System.Media;
using Microsoft.Win32;

namespace Votive.Win;

/// <summary>What an alert says and which sound goes with it.</summary>
public sealed record AlertInfo(string Title, string Body, AgentState Tone, string SoundKey);

public static class Alerts
{
    /// <summary>
    /// The alert for a session whose state just changed from `from` (null when first seen), or null when
    /// the change is not worth interrupting for. Mirrors the macOS app: needs you, error, stuck, stopped,
    /// and finished (only when it was working before). A session that first appears starting or working
    /// is silent; one that first appears already needing you is not.
    /// </summary>
    public static AlertInfo? ForTransition(AgentState? from, AgentState to, SessionEntry e)
    {
        if (from == to) return null;
        var who = $"{e.Project} · {e.Agent}";
        return to switch
        {
            AgentState.NeedsInput => new AlertInfo(who + " needs you", e.Detail != null ? "Wants: " + e.Detail : e.Prompt ?? "Waiting for your answer.", to, "soundNeedsYou"),
            AgentState.Warning => new AlertInfo(who + " hit an error", e.Detail ?? e.Prompt ?? "A tool or turn failed; the session is still alive.", to, "soundError"),
            AgentState.Stuck => new AlertInfo(who + " seems stuck", "No activity for a while.", to, "soundStuck"),
            AgentState.Stopped when from != null => new AlertInfo(who + " stopped", "Its process is gone.", to, "soundStopped"),
            AgentState.Done when from is AgentState.Working or AgentState.Starting or AgentState.Stuck => new AlertInfo(who + " finished", e.Prompt ?? "Done.", to, "soundDone"),
            _ => null,
        };
    }

    /// <summary>The alert for a request a session made to be told something (the notify tool), or null.</summary>
    public static AlertInfo? ForNotify(SessionEntry e, AppSettings s, long lastSeenNotifyAt) =>
        s.CustomNotify && e.NotifyAt is { } at && at > lastSeenNotifyAt && !string.IsNullOrWhiteSpace(e.NotifyMessage)
            ? new AlertInfo($"{e.Project} · {e.Agent}", e.NotifyMessage!, AgentState.Starting, "soundNotify")
            : null;

    public static string SoundValue(AppSettings s, string key) => key switch
    {
        "soundNotify" => s.SoundNotify, "soundNeedsYou" => s.SoundNeedsYou, "soundError" => s.SoundError,
        "soundStuck" => s.SoundStuck, "soundStopped" => s.SoundStopped, "soundDone" => s.SoundDone, _ => "none",
    };
}

/// <summary>What a sound setting means on Windows. Setting values come from the shared settings, where the
/// names are macOS system sounds; each maps to the nearest Windows system sound. A file is a plain .wav name
/// or .mp3 file in ~/.votive/sounds (no folders, nothing outside that directory).</summary>
public abstract record SoundChoice
{
    public sealed record None : SoundChoice;
    public sealed record System(string Name) : SoundChoice;   // Asterisk | Beep | Exclamation | Hand | Question
    public sealed record File(string Name) : SoundChoice;

    public static SoundChoice Parse(string? value, Func<string, bool> fileExists)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Equals("none", StringComparison.OrdinalIgnoreCase)) return new None();
        var mapped = value.ToLowerInvariant() switch
        {
            "glass" or "ping" or "tink" or "pop" => "Asterisk",
            "basso" or "sosumi" or "funk" or "blow" => "Hand",
            "hero" or "submarine" => "Exclamation",
            "frog" or "bottle" or "morse" or "purr" => "Beep",
            _ => null,
        };
        if (mapped != null) return new System(mapped);
        if (value.Contains('/') || value.Contains('\\') || value.Contains("..") || value.Contains('"') || value.Any(char.IsControl)) return new None();
        bool audio = value.EndsWith(".wav", StringComparison.OrdinalIgnoreCase) || value.EndsWith(".mp3", StringComparison.OrdinalIgnoreCase);
        return audio && fileExists(value) ? new File(value) : new None();
    }
}

public static class SoundPlayerEx
{
    // Windows' built-in media control interface plays mp3 with no package and no web engine.
    [System.Runtime.InteropServices.DllImport("winmm.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern int mciSendString(string command, System.Text.StringBuilder? result, int resultLength, IntPtr callback);

    public static void Play(SoundChoice choice, string soundsDir)
    {
        try
        {
            switch (choice)
            {
                case SoundChoice.System s:
                    (s.Name switch { "Hand" => SystemSounds.Hand, "Exclamation" => SystemSounds.Exclamation, "Beep" => SystemSounds.Beep, "Question" => SystemSounds.Question, _ => SystemSounds.Asterisk }).Play();
                    break;
                case SoundChoice.File f when f.Name.EndsWith(".mp3", StringComparison.OrdinalIgnoreCase):
                    mciSendString("close votiveSound", null, 0, IntPtr.Zero);   // one sound at a time; the name was checked to hold no quote
                    if (mciSendString($"open \"{Path.Combine(soundsDir, f.Name)}\" type mpegvideo alias votiveSound", null, 0, IntPtr.Zero) == 0)
                        mciSendString("play votiveSound", null, 0, IntPtr.Zero);
                    break;
                case SoundChoice.File f:
                    new SoundPlayer(Path.Combine(soundsDir, f.Name)).Play();   // async, on its own thread
                    break;
            }
        }
        catch { /* a missing or broken sound must never break the app */ }
    }
}

/// <summary>Start-with-Windows: one value under the current user's Run key, no admin needed.</summary>
public static class Autostart
{
    public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string ValueName = "Votive";

    /// <summary>The command stored in the Run key: the exe path in quotes, nothing else.</summary>
    public static string CommandFor(string exePath) => "\"" + exePath.Replace("\"", "") + "\"";

    public static bool IsOn(string keyPath = RunKey, string valueName = ValueName)
    {
        try { using var k = Registry.CurrentUser.OpenSubKey(keyPath); return k?.GetValue(valueName) is string s && s.Length > 0; }
        catch { return false; }
    }

    public static void Set(bool on, string exePath, string keyPath = RunKey, string valueName = ValueName)
    {
        using var k = Registry.CurrentUser.CreateSubKey(keyPath);
        if (on) k.SetValue(valueName, CommandFor(exePath));
        else k.DeleteValue(valueName, throwOnMissingValue: false);
    }
}
