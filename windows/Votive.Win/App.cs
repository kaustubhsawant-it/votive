using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace Votive.Win;

/// <summary>
/// Wires the shared state folders to the pill, the flyout, the alert panel and the tray icon. Zero idle
/// cost: file watchers wake it, a one-shot debounce coalesces bursts, and the only recurring timer runs
/// while sessions or usage exist (to notice a dead process, quiet work, or a window that reset).
/// </summary>
public sealed class App : ApplicationContext
{
    const int LivenessMs = 30_000, DebounceMs = 120, MaxQueued = 5;

    readonly string _dir = EventStore.EventsDir();
    readonly PillWindow _pill = new();
    readonly FlyoutWindow _flyout = new();
    readonly AlertWindow _alert = new();
    readonly NotifyIcon _tray = new();
    readonly System.Windows.Forms.Timer _debounce = new() { Interval = DebounceMs };
    readonly System.Windows.Forms.Timer _liveness = new() { Interval = LivenessMs };
    readonly Dictionary<string, AgentState> _lastState = new();
    readonly Dictionary<string, long> _lastNotify = new();
    readonly Queue<AlertInfo> _queue = new();
    readonly Dictionary<PillMode, ToolStripMenuItem> _modeItems = new();
    readonly List<(ToolStripMenuItem Item, Func<bool> On)> _checks = new();
    FileSystemWatcher? _watch, _settingsWatch, _usageWatch;
    List<(AgentState State, SessionEntry Entry)> _rows = new();
    UsageSummary? _usage;
    AppSettings _settings = SettingsStore.Load();
    AgentState? _iconState;
    bool _iconBadge, _seeded;
    string _lastSummary = "";

    public App()
    {
        try { Directory.CreateDirectory(_dir); } catch { /* shown as "no sessions" */ }
        _ = _pill.Handle;   // the watchers marshal to the UI thread through this handle, so it must exist first
        _pill.ApplySettings(_settings);
        _pill.Dropped += p => SetMode(PillMode.Custom, p);
        _pill.Clicked += anchor => ToggleFlyout(anchor);
        _alert.Dismissed += ShowNextAlert;
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ToggleFlyout(new Rectangle(Cursor.Position, new Size(1, 1))); };
        _debounce.Tick += (_, _) => { _debounce.Stop(); ReloadSettings(); Refresh(); };
        _liveness.Tick += (_, _) => Refresh();

        _tray.ContextMenuStrip = BuildMenu();
        _tray.Visible = true;
        SetTrayIcon(AgentState.Done, "Votive: no sessions", false);

        _watch = Watch(_dir, "*.json", 16 * 1024);
        _settingsWatch = Watch(Path.GetDirectoryName(SettingsStore.FilePath())!, Path.GetFileName(SettingsStore.FilePath()), 8 * 1024);
        _usageWatch = Watch(UsageStore.UsageDir(), "*.json", 8 * 1024);
        Refresh();
    }

    FileSystemWatcher? Watch(string dir, string filter, int buffer)
    {
        try
        {
            Directory.CreateDirectory(dir);
            var w = new FileSystemWatcher(dir, filter) { NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size, InternalBufferSize = buffer };
            FileSystemEventHandler kick = (_, _) => Kick();
            w.Created += kick; w.Changed += kick; w.Deleted += kick;
            w.Renamed += (_, _) => Kick();
            w.Error += (_, _) => Kick();
            w.EnableRaisingEvents = true;
            return w;
        }
        catch { return null; /* the minute tick still refreshes while there is something to watch */ }
    }

    // Watchers fire on thread-pool threads; hop to the UI thread through the pill's handle.
    void Kick()
    {
        try { _pill.BeginInvoke(() => { _debounce.Stop(); _debounce.Start(); }); }
        catch { /* shutting down */ }
    }

    // ---- the menu ----
    ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        var position = new ToolStripMenuItem("Where the pill sits");
        void Mode(PillMode m, string text)
        {
            var item = new ToolStripMenuItem(text);
            item.Click += (_, _) => SetMode(m);
            _modeItems[m] = item; position.DropDownItems.Add(item);
        }
        Mode(PillMode.Top, "Top of the screen");
        Mode(PillMode.Taskbar, "In the taskbar (next to the tray, may cover buttons)");
        Mode(PillMode.Custom, "Where I dragged it");
        Mode(PillMode.TrayOnly, "Tray icon only (no pill)");
        menu.Items.Add(position);

        ToolStripMenuItem Toggle(string text, Func<bool> on, Action<bool> set)
        {
            var item = new ToolStripMenuItem(text);
            item.Click += (_, _) => { try { set(!on()); } catch { /* shown unchanged */ } };
            _checks.Add((item, on)); return item;
        }
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Toggle("Pop up when a session needs me or finishes", () => _settings.PopupAlerts, v => Apply("dialogAlertsOn", v)));
        menu.Items.Add(Toggle("Play sounds", () => _settings.Sounds, v => Apply("soundsOn", v)));
        menu.Items.Add(Toggle("Warn when a plan limit passes 70%", () => _settings.UsageAlert, v => Apply("usageAlertOn", v)));
        var stuck = new ToolStripMenuItem("Mark a session stuck after");
        foreach (var (minutes, text) in new[] { (0, "Never"), (5, "5 minutes"), (8, "8 minutes"), (15, "15 minutes"), (30, "30 minutes") })
        {
            var item = new ToolStripMenuItem(text);
            item.Click += (_, _) => { try { SettingsStore.SetInt("stuckThresholdMinutes", minutes); Reapply(); } catch { } };
            _checks.Add((item, () => _settings.StuckMinutes == minutes)); stuck.DropDownItems.Add(item);
        }
        menu.Items.Add(stuck);
        var test = new ToolStripMenuItem("Show a test alert");
        test.Click += (_, _) => Raise(new AlertInfo("Test · Votive", "This is what an alert looks like. Pop-ups and sounds follow the settings above.", AgentState.NeedsInput, "soundNeedsYou"), popup: true);
        menu.Items.Add(test);
        menu.Items.Add(new ToolStripSeparator());
        var agentChanges = Toggle("Let agents change settings", () => SettingsStore.GetBool("agentWritesAllowed"), v => SettingsStore.SetBool("agentWritesAllowed", v));
        agentChanges.ToolTipText = "Off by default. When on, an agent you ask can change these settings or repair this install through the MCP tools, a few times an hour. Every change is logged in %USERPROFILE%\\.votive\\audit.jsonl.";
        menu.Items.Add(agentChanges);
        menu.Items.Add(Toggle("Start with Windows", () => Autostart.IsOn(), v => Autostart.Set(v, Environment.ProcessPath ?? "")));
        var quit = new ToolStripMenuItem("Quit Votive");
        quit.Click += (_, _) => ExitThread();
        menu.Items.Add(quit);
        StyleDropDown(menu);
        foreach (ToolStripItem top in menu.Items) if (top is ToolStripMenuItem m && m.HasDropDownItems) StyleDropDown(m.DropDown);
        menu.Opening += (_, _) =>
        {
            foreach (var (m, item) in _modeItems) item.Checked = _settings.Mode == m;
            _modeItems[PillMode.Custom].Enabled = _settings.Custom != null;
            foreach (var (item, on) in _checks) item.Checked = on();
        };
        return menu;
    }

    // Menus get Windows 11's rounded corners and the system font; the colours follow the system colour mode.
    static void StyleDropDown(ToolStripDropDown dd)
    {
        dd.Font = Theme.Body(9.5f);
        dd.HandleCreated += (_, _) => Native.Style(dd.Handle, !Theme.AppsLight, Native.Corner.Round, null);
    }

    void Apply(string key, bool value) { SettingsStore.SetBool(key, value); Reapply(); }
    void Reapply() { _settings = SettingsStore.Load(); _pill.ApplySettings(_settings); Refresh(); }

    // ---- refresh ----
    void Refresh()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var rows = EventStore.Scan(_dir)
            .Select(e => (State: StateResolver.Resolve(e.LastEvent, e.LastEventAt, now, EventStore.IsAlive(e.Pid), _settings.StuckMinutes), Entry: e))
            .OrderBy(r => StateResolver.Priority(r.State)).ThenByDescending(r => r.Entry.LastEventAt)
            .ToList();
        _rows = rows;
        _usage = UsageStore.Scan(UsageStore.UsageDir(), now);
        DetectChanges(rows);
        _pill.SetRows(rows);
        if (_flyout.Visible) _flyout.Update(rows, _usage, now);
        _liveness.Enabled = rows.Count > 0 || _usage != null;
        bool badge = _settings.UsageAlert && _usage is { OverThreshold: true };
        var usageNote = _usage is { OverThreshold: true } ? $" · usage {_usage.Highest}%" : "";
        if (rows.Count == 0) { SetTrayIcon(AgentState.Done, "Votive: no sessions" + usageNote, badge); return; }
        var counts = rows.GroupBy(r => r.State).OrderBy(g => StateResolver.Priority(g.Key)).Select(g => $"{g.Count()} {StateResolver.Label(g.Key)}");
        SetTrayIcon(rows[0].State, "Votive: " + string.Join(", ", counts) + usageNote, badge);
    }

    // What changed since the last look? The first look only records, so starting the app never alerts about old sessions.
    void DetectChanges(List<(AgentState State, SessionEntry Entry)> rows)
    {
        var present = new HashSet<string>();
        foreach (var (state, e) in rows)
        {
            var key = e.Agent + ":" + e.SessionId;
            present.Add(key);
            AgentState? prev = _lastState.TryGetValue(key, out var p) ? p : null;
            long seen = _lastNotify.TryGetValue(key, out var n) ? n : (_seeded ? 0 : e.NotifyAt ?? 0);
            if (_seeded)
            {
                var change = Alerts.ForTransition(prev, state, e);
                if (change != null) Raise(change, popup: _settings.PopupAlerts);
                var ask = Alerts.ForNotify(e, _settings, seen);
                if (ask != null) Raise(ask, popup: true);
            }
            _lastState[key] = state;
            _lastNotify[key] = Math.Max(seen, e.NotifyAt ?? 0);
        }
        foreach (var gone in _lastState.Keys.Where(k => !present.Contains(k)).ToList()) { _lastState.Remove(gone); _lastNotify.Remove(gone); }
        _seeded = true;
    }

    void Raise(AlertInfo a, bool popup)
    {
        if (_settings.Sounds)
        {
            var dir = Path.Combine(EventStore.Root(), "sounds");
            SoundPlayerEx.Play(SoundChoice.Parse(Alerts.SoundValue(_settings, a.SoundKey), name => File.Exists(Path.Combine(dir, name))), dir);
        }
        if (!popup || _flyout.Visible) return;   // the list is open: you are already looking at it, so no panel over it
        if (_alert.Visible) { if (_queue.Count < MaxQueued) _queue.Enqueue(a); return; }
        _alert.ShowAlert(a, AlertAnchor());
    }

    void ShowNextAlert() { if (_queue.Count > 0) _alert.ShowAlert(_queue.Dequeue(), AlertAnchor()); }

    /// <summary>--demo-open: after a moment open the list, then show a sample alert, so a screenshot can check both.</summary>
    public void DemoOpen()
    {
        _flyout.StayOpen = true;
        var t = new System.Windows.Forms.Timer { Interval = 2500 };
        int step = 0;
        t.Tick += (_, _) =>
        {
            if (step == 0) Raise(new AlertInfo("api · claude-code needs you", "Wants: Bash", AgentState.NeedsInput, "soundNeedsYou"), popup: true);
            else if (step == 1) ToggleFlyout(_pill.Visible ? _pill.Bounds : new Rectangle(Cursor.Position, new Size(1, 1)));
            else t.Stop();
            step++;
        };
        t.Start();
    }

    // Where Windows puts its own toasts: the bottom-right corner, above the taskbar.
    Rectangle AlertAnchor()
    {
        var wa = (Screen.PrimaryScreen ?? Screen.AllScreens[0]).WorkingArea;
        return new Rectangle(wa.Right - 1, wa.Bottom - 1, 1, 1);
    }

    void ToggleFlyout(Rectangle anchor)
    {
        if (_flyout.Visible) { _flyout.Hide(); return; }
        _flyout.ShowAt(_rows, _usage, anchor, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    void ReloadSettings()
    {
        var fresh = SettingsStore.Load();
        if (fresh == _settings) return;
        _settings = fresh;
        _pill.ApplySettings(_settings);
    }

    // The menu and a drag both end up here: remember the choice, apply it now. The settings watcher then
    // sees our own write and reloads the same values, which changes nothing.
    void SetMode(PillMode mode, Point? custom = null)
    {
        var keep = mode == PillMode.Custom ? (custom ?? _settings.Custom) : _settings.Custom;
        if (mode == PillMode.Custom && keep == null) return;   // nothing dragged yet
        try { SettingsStore.Save(mode, mode == PillMode.Custom ? keep : null); } catch { /* applied for this run anyway */ }
        _settings = _settings with { Mode = mode, Custom = keep };
        _pill.ApplySettings(_settings);
    }

    void SetTrayIcon(AgentState state, string text, bool badge)
    {
        if (text.Length > 63) text = text[..63];
        if (text != _lastSummary) { _tray.Text = text; _lastSummary = text; }
        if (_iconState == state && _iconBadge == badge) return;
        _iconState = state; _iconBadge = badge;
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var b = new SolidBrush(StateResolver.ColorOf(state));
            g.FillEllipse(b, 4, 4, 24, 24);
            if (StateResolver.WantsAttention(state)) { using var pen = new Pen(Color.White, 3); g.DrawEllipse(pen, 3, 3, 26, 26); }
            if (badge) { using var red = new SolidBrush(Color.FromArgb(255, 69, 58)); using var edge = new Pen(Color.FromArgb(28, 28, 30), 2); g.FillEllipse(red, 18, 18, 13, 13); g.DrawEllipse(edge, 18, 18, 13, 13); }
        }
        var hIcon = bmp.GetHicon();
        var old = _tray.Icon;
        using (var fresh = Icon.FromHandle(hIcon)) _tray.Icon = (Icon)fresh.Clone();
        DestroyIcon(hIcon);
        old?.Dispose();
    }

    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

    protected override void ExitThreadCore()
    {
        _watch?.Dispose(); _settingsWatch?.Dispose(); _usageWatch?.Dispose();
        _debounce.Dispose(); _liveness.Dispose();
        _tray.Visible = false; _tray.Dispose(); _alert.Dispose(); _flyout.Dispose(); _pill.Dispose();
        base.ExitThreadCore();
    }
}
