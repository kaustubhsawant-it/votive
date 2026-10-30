namespace Votive.Win;

public static class Format
{
    /// <summary>"now", "45s", "3m", "2h", "5d": how long ago, short enough for a row. A future time reads as "now".</summary>
    public static string Ago(long thenMs, long nowMs)
    {
        long s = (nowMs - thenMs) / 1000;
        if (s < 5) return "now";
        if (s < 60) return s + "s";
        if (s < 3600) return s / 60 + "m";
        if (s < 86400) return s / 3600 + "h";
        return s / 86400 + "d";
    }

    /// <summary>"2h 10m", "45m", "3d 4h", "&lt;1m": a duration for "resets in ...".</summary>
    public static string Duration(long ms)
    {
        long m = ms / 60000;
        if (m < 1) return "<1m";
        if (m < 60) return m + "m";
        if (m < 1440) return m / 60 + "h" + (m % 60 == 0 ? "" : " " + m % 60 + "m");
        return m / 1440 + "d" + (m / 60 % 24 == 0 ? "" : " " + m / 60 % 24 + "h");
    }
}
