import Foundation

/// One line of `~/.votive/usage/history/<agent>.jsonl`: percentages and reset times only.
struct HabitSample: Equatable {
    let t: Double          // epoch ms
    let s: Double?         // session %
    let sr: Double?        // session resets (epoch s)
    let w: Double?         // weekly %
    let wr: Double?        // weekly resets (epoch s)
}

/// Reads the usage history without trusting it. Same checks as Scripts/usage-history.js (`validSample`): a value out
/// of range drops the line, a torn line is skipped, a link, device or oversized file reads as empty.
enum HabitsHistory {
    static let folder = Paths.usage.appendingPathComponent("history", isDirectory: true)
    static let limit = 2 * 1024 * 1024

    /// Agents that have a history file, Claude Code first.
    static func agents() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        let ids = names.filter { $0.hasSuffix(".jsonl") }.map { String($0.dropLast(".jsonl".count)) }.sorted()
        let first: [String] = ids.filter { $0 == AgentKind.claudeCode }
        let rest: [String] = ids.filter { $0 != AgentKind.claudeCode }
        return first + rest
    }

    static func read(agent: String) -> [HabitSample] {
        guard !agent.contains("/"),
              let data = BoundedRead.data(at: folder.appendingPathComponent(agent + ".jsonl"), limit: limit),
              let text = String(data: data, encoding: .utf8) else { return [] }
        return parse(text)
    }

    /// Every valid sample in `text`, oldest first.
    static func parse(_ text: String) -> [HabitSample] {
        var out: [HabitSample] = []
        for line in text.split(separator: "\n") {
            guard let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
                  let sample = sample(obj) else { continue }
            out.append(sample)
        }
        return out.sorted { $0.t < $1.t }
    }

    private static func sample(_ o: [String: Any]) -> HabitSample? {
        func num(_ v: Any?) -> (ok: Bool, value: Double?) {
            if v == nil || v is NSNull { return (true, nil) }
            guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return (false, nil) }
            return (true, n.doubleValue)
        }
        guard let tRaw = o["t"] as? NSNumber, CFGetTypeID(tRaw) != CFBooleanGetTypeID() else { return nil }
        let t = tRaw.doubleValue
        guard t.isFinite, t > 1e12, t < 4e12 else { return nil }
        let s = num(o["s"]), w = num(o["w"]), sr = num(o["sr"]), wr = num(o["wr"])
        guard s.ok, w.ok, sr.ok, wr.ok else { return nil }
        if let v = s.value, v < 0 || v > 100 { return nil }
        if let v = w.value, v < 0 || v > 100 { return nil }
        if let v = sr.value, v <= 1e9 || v >= 4e9 { return nil }
        if let v = wr.value, v <= 1e9 || v >= 4e9 { return nil }
        return HabitSample(t: t, s: s.value, sr: sr.value, w: w.value, wr: wr.value)
    }
}

/// Usage habits: learns when the plan is used, forecasts where the weekly limit will stand at the reset, and says
/// so in plain sentences. A line-for-line port of Scripts/usage-habits.js (tests/usage-habits-parity.test.js runs both
/// on the same history and requires the same numbers and the same sentences). Pure: Foundation only, no files, no
/// network, nothing runs.
///
/// A small statistical model, not a neural network, on purpose: the history is a few percentage points per hour, so a
/// model with thousands of parameters would only memorise it. See the header of the script for the reasoning.
struct UsageHabits {
    static let hour = 3_600_000.0
    static let day = 24 * hour
    static let maxGapHours = 12.0
    static let halfLifeDays = 7.0
    static let shrink = 2.0
    static let minDaysForecast = 2
    static let minDaysRange = 4
    static let minDaysBacktest = 4
    /// Fewer days than this never earn a "better than average" verdict.
    static let sureDays = 14

    let timeZone: TimeZone
    private let calendar: Calendar

    init(timeZone: TimeZone = .current) {
        self.timeZone = timeZone
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        calendar = c
    }

    // MARK: - Clock

    private func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }
    private func dayKey(_ ms: Double) -> Int {
        let c = calendar.dateComponents([.year, .month, .day], from: date(ms))
        return c.year! * 10000 + c.month! * 100 + c.day!
    }
    private func isWeekend(_ ms: Double) -> Bool { let w = calendar.component(.weekday, from: date(ms)); return w == 1 || w == 7 }
    func hourOf(_ ms: Double) -> Int { calendar.component(.hour, from: date(ms)) }
    /// Start of the local clock hour (so a half-hour zone still has hours that begin on :00).
    func startOfHour(_ ms: Double) -> Double {
        let east = Double(timeZone.secondsFromGMT(for: date(ms))) * 1000
        return ((ms + east) / Self.hour).rounded(.down) * Self.hour - east
    }

    // MARK: - Hours

    struct Hourly {
        var cells: [Double: Double] = [:]
        var first: Double?
        var last: Double?
    }

    /// Points used in each local clock hour. Every hour from the first sample to the last is present; an hour with no
    /// sample is an hour of no use, and a pair of samples that crosses a window reset adds nothing.
    func hourlyUse(_ samples: [HabitSample]) -> Hourly {
        var u = Hourly()
        guard samples.count >= 2 else { return u }
        func touch(_ h: Double) { if u.cells[h] == nil { u.cells[h] = 0 } }
        for i in 1..<samples.count {
            let a = samples[i - 1], b = samples[i]
            guard let aw = a.w, let bw = b.w, a.wr == b.wr else { continue }
            let delta = max(0, bw - aw)
            let from = max(a.t, b.t - Self.maxGapHours * Self.hour)
            let first = startOfHour(from), last = startOfHour(b.t - 1)
            if last < first { continue }
            let n = Int(((last - first) / Self.hour).rounded()) + 1
            for k in 0..<n {
                let h = first + Double(k) * Self.hour
                touch(h)
                u.cells[h]! += delta / Double(n)
            }
        }
        var h = startOfHour(samples[0].t)
        let end = startOfHour(samples[samples.count - 1].t)
        while h <= end { touch(h); h += Self.hour }
        u.first = samples[0].t
        u.last = samples[samples.count - 1].t
        return u
    }

    private func fullyCovered(_ h: Double, _ u: Hourly) -> Bool {
        guard let first = u.first, let last = u.last else { return false }
        return h >= startOfHour(first) + Self.hour && h + Self.hour <= last
    }

    // MARK: - Model

    struct DayTotal: Equatable, Identifiable {
        let key: Int
        let total: Double
        let weekend: Bool
        let start: Double
        var id: Int { key }
    }

    struct Model {
        var we = [Double](repeating: 0, count: 24)
        var wd = [Double](repeating: 0, count: 24)
        var anyMean = [Double](repeating: 0, count: 24)
        var scaleWe = 1.0
        var scaleWd = 1.0
        var days: [DayTotal] = []
        var trainedOn = 0
    }

    /// Fits the model. `skipDay` leaves one local day out, which is how the backtest keeps its test honest.
    func fit(_ samples: [HabitSample], now: Double? = nil, skipDay: Int? = nil) -> Model {
        let use = hourlyUse(samples)
        let now = now ?? use.last ?? 0
        var wsumWe = [Double](repeating: 0, count: 24), wsumWd = wsumWe, wsumAny = wsumWe
        var sumWe = wsumWe, sumWd = wsumWe, sumAny = wsumWe
        var countWe = [Int](repeating: 0, count: 24), countWd = countWe
        struct Acc { var total = 0.0; var hours = 0; var weekend = false; var start = 0.0 }
        var days: [Int: Acc] = [:]
        for h in use.cells.keys.sorted() {
            guard fullyCovered(h, use) else { continue }
            let pts = use.cells[h]!
            let key = dayKey(h)
            if let skip = skipDay, key == skip { continue }
            let w = pow(0.5, max(0, now - h) / Self.day / Self.halfLifeDays)
            let we = isWeekend(h), hr = hourOf(h)
            if we { wsumWe[hr] += w; sumWe[hr] += w * pts; countWe[hr] += 1 }
            else { wsumWd[hr] += w; sumWd[hr] += w * pts; countWd[hr] += 1 }
            wsumAny[hr] += w; sumAny[hr] += w * pts
            var d = days[key] ?? Acc(total: 0, hours: 0, weekend: we, start: h)
            if h < d.start { d.start = h }
            d.total += pts; d.hours += 1
            days[key] = d
        }
        var model = Model()
        model.anyMean = (0..<24).map { wsumAny[$0] > 0 ? sumAny[$0] / wsumAny[$0] : 0 }
        let anyDaily = model.anyMean.reduce(0, +)
        for weekend in [true, false] {
            let wsum = weekend ? wsumWe : wsumWd, sum = weekend ? sumWe : sumWd, count = weekend ? countWe : countWd
            func cellMean(_ hr: Int) -> Double? { wsum[hr] > 0 ? sum[hr] / wsum[hr] : nil }
            var daily = 0.0, seen = 0
            for hr in 0..<24 { if let c = cellMean(hr) { daily += c; seen += 1 } }
            let nDays = Set(days.values.filter { $0.weekend == weekend }.map { dayKey($0.start) }).count
            let raw = anyDaily > 0 && seen == 24 ? daily / anyDaily : 1
            let scale = (Double(nDays) * raw + Self.shrink) / (Double(nDays) + Self.shrink)
            var cells = [Double](repeating: 0, count: 24)
            for hr in 0..<24 {
                let prior = model.anyMean[hr] * scale
                if let c = cellMean(hr) { let n = Double(count[hr]); cells[hr] = (n * c + Self.shrink * prior) / (n + Self.shrink) }
                else { cells[hr] = prior }
            }
            if weekend { model.we = cells; model.scaleWe = scale } else { model.wd = cells; model.scaleWd = scale }
        }
        model.days = days.compactMap { $0.value.hours == 24 ? DayTotal(key: $0.key, total: $0.value.total, weekend: $0.value.weekend, start: $0.value.start) : nil }
            .sorted { $0.start < $1.start }
        model.trainedOn = days.count
        return model
    }

    /// Expected points in the clock hour that starts at `h`.
    func expectedHour(_ m: Model, _ h: Double) -> Double { (isWeekend(h) ? m.we : m.wd)[hourOf(h)] }

    /// Expected points between `from` and `to` (ms).
    func expectedBetween(_ m: Model, from: Double, to: Double) -> Double {
        var sum = 0.0, t = from
        while t < to {
            let hs = startOfHour(t), next = min(to, hs + Self.hour)
            sum += expectedHour(m, hs) * ((next - t) / Self.hour)
            t = next
        }
        return sum
    }

    // MARK: - Backtest

    struct Backtest: Equatable {
        var days = 0
        var enough = false
        var maeModel = 0.0
        var maeBaseline = 0.0
        var beatsBaseline = false
    }

    private func mean(_ a: [Double]) -> Double { a.isEmpty ? 0 : a.reduce(0, +) / Double(a.count) }
    private func sd(_ a: [Double]) -> Double {
        if a.count < 2 { return 0 }
        let m = mean(a)
        return (a.reduce(0) { $0 + ($1 - m) * ($1 - m) } / Double(a.count - 1)).squareRoot()
    }

    /// Leave-one-day-out: fit without a whole day and predict its total; compare with "an average day".
    func backtest(_ samples: [HabitSample]) -> Backtest {
        let full = fit(samples)
        if full.days.count < Self.minDaysBacktest { return Backtest(days: full.days.count) }
        var errModel = 0.0, errBase = 0.0
        for d in full.days {
            let m = fit(samples, skipDay: d.key)
            var predicted = 0.0
            for k in 0..<24 { predicted += expectedHour(m, d.start + Double(k) * Self.hour) }
            let others = full.days.filter { $0.key != d.key }.map { $0.total }
            errModel += abs(predicted - d.total)
            errBase += abs(mean(others) - d.total)
        }
        let n = Double(full.days.count)
        return Backtest(days: full.days.count, enough: true, maeModel: errModel / n, maeBaseline: errBase / n, beatsBaseline: errModel < errBase)
    }

    // MARK: - Report

    struct Rhythm: Equatable {
        var peakStart = 0, peakEnd = 0
        var peakShare = 0.0
        var weekdayPerDay: Double?
        var weekendPerDay: Double?
        var weekdayDaytimeShare: Double?
        var totalPoints = 0.0
        var byHour = [Double](repeating: 0, count: 24)
    }

    struct Forecast: Equatable {
        var used = 0.0
        var resetsAt = 0.0
        var hoursLeft = 0.0
        var expectedMore = 0.0
        var projected = 0.0
        var low: Double?
        var high: Double?
        var spare = 0.0
        var over = 0.0
    }

    /// One hour of the forecast line: where the weekly percentage is expected to stand, with the range.
    struct PathPoint: Equatable, Identifiable {
        let at: Date
        let mid: Double
        let low: Double?
        let high: Double?
        var id: Date { at }
    }

    struct Report {
        var now = 0.0
        var target = 80.0
        var samples = 0
        var daysSeen = 0
        var trainedOn = 0
        var rhythm: Rhythm?
        var forecast: Forecast?
        var backtest = Backtest()
        var insights: [String] = []
        var model = Model()
        var path: [PathPoint] = []
    }

    private func currentWeekly(_ samples: [HabitSample], now: Double) -> HabitSample? {
        for x in samples.reversed() {
            guard x.w != nil, let wr = x.wr else { continue }
            return wr * 1000 > now ? x : nil
        }
        return nil
    }

    private func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }
    private func pct(_ v: Double) -> String { String(Int(jsRound(v))) + "%" }
    /// A number the way the script prints it: one decimal at most, none when whole.
    private func num(_ v: Double) -> String { let r = jsRound(v * 10) / 10; return r == r.rounded() ? String(Int(r)) : String(r) }
    private func hh(_ n: Int) -> String { (n < 10 ? "0" : "") + String(n) + ":00" }

    func analyse(_ samples: [HabitSample], target: Double = 80, now: Double? = nil) -> Report {
        let now = now ?? samples.last?.t ?? Date().timeIntervalSince1970 * 1000
        let model = fit(samples, now: now)
        var out = Report(now: now, target: target, samples: samples.count, daysSeen: model.days.count, trainedOn: model.trainedOn, model: model)
        guard !samples.isEmpty else { return out }

        let use = hourlyUse(samples)
        var byHour = [Double](repeating: 0, count: 24)
        var total = 0.0, weekendTotal = 0.0, weekdayTotal = 0.0
        var weekendDays = Set<Int>(), weekdayDays = Set<Int>()
        var dayUsed = 0.0, dayAll = 0.0
        for h in use.cells.keys.sorted() {
            guard fullyCovered(h, use) else { continue }
            let pts = use.cells[h]!
            byHour[hourOf(h)] += pts; total += pts
            if isWeekend(h) { weekendTotal += pts; weekendDays.insert(dayKey(h)) } else { weekdayTotal += pts; weekdayDays.insert(dayKey(h)) }
            dayAll += pts
            if !isWeekend(h), hourOf(h) >= 9, hourOf(h) < 18 { dayUsed += pts }
        }
        if total > 0 {
            var best = 0.0, bestAt = 0
            for s in 0..<24 {
                var m = 0.0
                for k in 0..<4 { m += byHour[(s + k) % 24] }
                if m > best { best = m; bestAt = s }
            }
            out.rhythm = Rhythm(peakStart: bestAt, peakEnd: (bestAt + 4) % 24, peakShare: best / total,
                                weekdayPerDay: weekdayDays.isEmpty ? nil : weekdayTotal / Double(weekdayDays.count),
                                weekendPerDay: weekendDays.isEmpty ? nil : weekendTotal / Double(weekendDays.count),
                                weekdayDaytimeShare: dayAll > 0 ? dayUsed / dayAll : nil,
                                totalPoints: total, byHour: byHour)
        }

        let ws = currentWeekly(samples, now: now)
        if let ws, let used = ws.w, let wr = ws.wr, model.days.count >= Self.minDaysForecast {
            let resetsAt = wr * 1000
            let expected = expectedBetween(model, from: now, to: resetsAt)
            let spread: Double? = model.days.count >= Self.minDaysRange ? sd(model.days.map { $0.total }) : nil
            let daysLeft = max(0, (resetsAt - now) / Self.day)
            let half = spread.map { 1.28 * $0 * daysLeft.squareRoot() }
            let projected = used + expected
            out.forecast = Forecast(used: used, resetsAt: resetsAt, hoursLeft: (resetsAt - now) / Self.hour, expectedMore: expected,
                                    projected: projected, low: half.map { max(used, projected - $0) }, high: half.map { min(999, projected + $0) },
                                    spare: max(0, target - projected), over: max(0, projected - target))
            // The line the chart draws: expected points added hour by hour, the range widening like the square root of time.
            var t = now
            var cumulative = 0.0
            out.path.append(PathPoint(at: date(now), mid: used, low: spread == nil ? nil : used, high: spread == nil ? nil : used))
            while t < resetsAt {
                let hs = startOfHour(t), next = min(resetsAt, hs + Self.hour)
                cumulative += expectedHour(model, hs) * ((next - t) / Self.hour)
                t = next
                let spreadNow = spread.map { 1.28 * $0 * (max(0, (t - now) / Self.day)).squareRoot() }
                let mid = used + cumulative
                out.path.append(PathPoint(at: date(t), mid: mid, low: spreadNow.map { max(used, mid - $0) }, high: spreadNow.map { min(999, mid + $0) }))
            }
        }
        out.backtest = backtest(samples)

        // Plain sentences (the same words as the script).
        let r = out.rhythm, f = out.forecast, b = out.backtest
        if let r {
            out.insights.append("Most of your use (" + pct(r.peakShare * 100) + ") falls between " + hh(r.peakStart) + " and " + hh(r.peakEnd) + ".")
            if let wd = r.weekdayPerDay, let we = r.weekendPerDay {
                out.insights.append("Weekdays average " + num(wd) + " points a day, weekend days " + num(we) + ".")
            }
            if let share = r.weekdayDaytimeShare, share < 0.1, weekdayDays.count >= 2 {
                out.insights.append("Weekday working hours (09:00 to 18:00) hold " + (share < 0.005 ? "almost none" : "only " + pct(share * 100))
                    + " of your use, so the limit is spent in the evening and at the weekend.")
            }
        }
        let tgt = String(Int(target)) + "%"
        if let f {
            let range = (f.low != nil && f.high != nil) ? " (likely " + pct(f.low!) + " to " + pct(f.high!) + ")" : ""
            out.insights.append("Forecast at the reset: " + pct(f.projected) + range + " of the weekly limit, from " + pct(f.used) + " now.")
            if f.projected >= 100 { out.insights.append("At your usual pace the limit runs out before the reset; move big jobs after it.") }
            else if f.over > 0 { out.insights.append("That is " + pct(f.over) + " over your " + tgt + " target.") }
            else if f.spare >= 5 {
                out.insights.append("About " + pct(f.spare) + " of the week is likely to go unused against your " + tgt + " target. A longer job in your usual "
                    + hh(r?.peakStart ?? 20) + " stretch would use it.")
            } else { out.insights.append("That is close to your " + tgt + " target.") }
        } else if ws != nil {
            out.insights.append("Not enough days seen yet for a forecast (" + String(model.days.count) + " whole days; it needs " + String(Self.minDaysForecast) + ").")
        } else {
            out.insights.append("No current weekly reading: nothing has been recorded since the last reset.")
        }
        if b.enough {
            let m = num(b.maeModel), base = num(b.maeBaseline)
            let clear = b.beatsBaseline && b.maeModel <= 0.9 * b.maeBaseline && b.days >= Self.sureDays
            let verdict = clear ? "It predicts your days better than a plain average."
                : b.beatsBaseline ? "That is slightly better, but " + String(b.days) + " days is too few to be sure, so read the range, not the single number."
                : "It is not better yet, so treat the forecast as a rough guess."
            out.insights.append("Check: on days it had not seen, it was off by " + m + " points against " + base + " for \"an average day\". " + verdict)
        } else {
            out.insights.append("Too early to test it: " + String(b.days) + " whole days seen, it needs " + String(Self.minDaysBacktest)
                + ". Four weeks of history will make this far more reliable.")
        }
        return out
    }
}
