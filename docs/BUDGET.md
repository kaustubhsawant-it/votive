# Budget mode (optional)

Budget mode helps you stay inside your Claude plan's limits without stopping work. It is **optional,
Claude Code only**, and off until you load it. This page says what it does, how to use it, and, just as
important, what it does not do and what has not been proven yet.

## What it does

When your plan usage passes a level you choose (85% of the 5-hour session window by default; the weekly
window is off until you set a level), sessions become **light**:

- new subagents are paused (Claude is told why, and how to allow them);
- reasoning effort is lowered to the lowest setting;
- one fixed notice is added to your next prompt: "plan usage is N% ... keep work lean ... write a short
  handoff note now".

Sessions you mark **heavy** are left alone (they only get the notice at 97% and above). Below the level,
nothing changes. If anything goes wrong inside the mod it does nothing: it never blocks or delays you.

## What it never does

- It never sends a prompt, types anything, or sends a message to another session.
- It never goes online and starts no program.
- It does not touch your credentials or Claude Code itself.
- It does not help you get around a limit. It only asks Claude to use less.
- It never lets a model loosen its own limits: `/budget heavy` is a command **you** type; text in a prompt or
  a message from another session that says "/budget heavy" does nothing.

## Using it

Load it for one session: `claude --plugin-dir mods/votive-budget` (from this repository). A permanent
install path (a plugin marketplace entry) is not built yet.

Commands, typed by you in the session:

| Command | Effect |
|---|---|
| `/budget status` | mode, level, and the current usage |
| `/budget heavy` / `/budget light` | this session only |
| `/budget project heavy` / `project light` | add or remove this folder from the always-heavy list |

Settings are kept in `~/.votive/budget/policy.json`. Change them from a terminal:

    node Scripts/budget-policy.js status
    node Scripts/budget-policy.js level session 90        # 1-100
    node Scripts/budget-policy.js level weekly 80         # or: off
    node Scripts/budget-policy.js mode heavy              # the machine-wide default
    node Scripts/budget-policy.js project add /work/big   # an absolute folder
    node Scripts/budget-policy.js harden                  # make the folder private (0700) and the file 0600

(This script needs Node 22.12 or newer; everything else in Votive works on Node 18.)

## Checking on it

- `node Scripts/doctor.js` warns if Claude Code's *Continue automatically at usage limit* is off, or if your
  Claude Code is older than 2.1.234 (before it could continue by itself), and says "unknown" rather than
  guessing when it does not know the version.
- `node Scripts/budget-report.js` prints a short report with your settings, usage now, and what the mod did
  over the last 14 days (counts only). Safe to paste into a message: no paths, no names, no prompts.

## Plan-limit notices

When Claude Code hits a plan limit, you get one panel saying what will happen: it should continue by itself
shortly after the reset; or it will not (the reset is more than a day away, so use `/rate-limit-options`); or
automatic continue is turned off; or your Claude Code is too old; or "check Claude Code" when the version is
not known. It is shown once per reset time. Claude Code's own automatic continue does the continuing; Votive never does.

## What is and is not proven

Proven here: the mod loads in Claude Code 2.1.287, `/budget` runs, policy and diagnostics files are written
correctly, every pure rule is tested (including hostile files and numbers), and the declared API calls match
a fixed allow-list.

**Seen live (2026-10-20, Claude Code 2.1.287, a real interactive session with real plan readings of 24 to 28%, level set to 1% to force light mode):** the status line showed "budget: light, session N%"; the fixed notice reached the model on every turn (it quoted it back); a subagent request was denied with the fixed text ("Subagent spawn denied by a plugin ... Use /budget heavy to allow them"); after `/budget heavy` typed by the user the same request ran; the mod's own counters recorded 1 denied subagent, 3 notices and 4 effort-lowering calls.

**Not confirmed:** that Claude Code actually honoured the lowered reasoning effort. The counter shows the mod asked for it 4 times, but the session's status line kept saying "high", so the effect is not observed. Also untested live: the weekly level, a level at the default 85%, heavy project folders, and a permanent install (the mod is still loaded per session with `--plugin-dir`). Treat the notice and the subagent pause as demonstrated, and the effort lowering as designed.

Other limits: the policy file is written by Claude Code with your normal file permissions (use `harden`);
Windows file modes are not Unix modes, so privacy there rests on your profile folder's permissions; a mod
runs with your permissions, so read `mods/votive-budget/hooks/*` (about 300 lines) before trusting it.

## Turning it off

Start Claude Code without `--plugin-dir`. Delete `~/.votive/budget/` to remove its files.

## Usage habits (optional, for you only)

`node ~/.votive/bin/usage-habits.js [--target 80] [--json]` reads the usage history that the pacing advisor
already keeps (percentages and reset times, nothing else) and tells you, in a few sentences, when you use your
plan, where the weekly limit is heading, and whether that fits your target.

How it works, so you can check it:

- **Points per hour.** The rise of the weekly percentage between two samples is the use in those hours. A window
  reset is never counted as use, and an hour with no sample is an hour of no use (the status line only reports
  while an agent runs).
- **A small model.** An expected value for every (weekday or weekend, hour of the day), weighted so last week
  counts more than a month ago (half-life 7 days). A cell seen only a few times leans on the usual shape of that
  hour of the day, scaled by how busy that kind of day is. So one busy Saturday cannot set your whole weekend.
- **The forecast** adds the expected points for each hour left until the reset. The range comes from how much
  whole days differ from each other.
- **It tests itself.** For each whole day it predicts that day from the others and compares with "an average day".
  Under 14 days of history it never claims to beat the average; it says the sample is too small.

It is not a neural network, on purpose: with a few hundred hourly numbers, a bigger model would only memorise them.
It is built so that more history makes it better (the cells fill in, the range narrows), and it can be swapped for
a heavier model later behind the same report once there are weeks of data.

It only reads the history file. It writes nothing, opens no connection, starts no program and sends nothing, and
a test fails if it ever gains any of those. It gives advice; it never acts.
