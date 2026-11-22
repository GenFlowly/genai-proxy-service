import SwiftUI

/// Wording and formatting for the activity panel (activity.format.ts).
enum ActivityFormat {
    /// "0.4s", "4.8s", "14s", "1m 05s".
    static func duration(_ ms: Int?) -> String {
        guard let ms else { return "" }
        let value = max(0, ms)
        if value < 10_000 { return String(format: "%.1fs", max(0.1, Double(value) / 1000)) }
        if value < 60_000 { return "\(Int((Double(value) / 1000).rounded()))s" }
        var minutes = value / 60_000
        var seconds = Int((Double(value % 60_000) / 1000).rounded())
        if seconds == 60 { minutes += 1; seconds = 0 }
        return "\(minutes)m " + String(format: "%02d", seconds) + "s"
    }

    /// The letter shown when a site has no usable icon.
    static func monogram(_ domain: String) -> String {
        guard let first = domain.first(where: { $0.isLetter || $0.isNumber }) else { return "?" }
        return String(first).uppercased()
    }

    /// Only https icons load: App Transport Security blocks http ones.
    static func usableFavicon(_ favicon: String?) -> URL? {
        guard let favicon, favicon.hasPrefix("https://") else { return nil }
        return URL(string: favicon)
    }

    private static let rfc1123: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return f
    }()
    private static let dayOnly: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let display: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        // Providers send midnight UTC for a calendar date; the viewer's timezone would
        // move it to the previous day west of Greenwich.
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    /// A source's publish date as a short calendar date ("Oct 25, 2026").
    static func sourceDate(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        let date = rfc1123.date(from: raw)
            ?? iso.date(from: raw)
            ?? dayOnly.date(from: String(raw.prefix(10)))
        return date.map { display.string(from: $0) }
    }

    private static let friendlyTools: [String: String] = [
        "web_search": "conversation.activity.tool.webSearch",
        "search_knowledge_base": "conversation.activity.tool.knowledge",
        "spawn_agent": "conversation.activity.tool.subagent",
        "write_todos": "conversation.activity.tool.plan",
        "fs_read": "conversation.activity.tool.fileRead",
        "fs_write": "conversation.activity.tool.fileWrite",
        "fs_list": "conversation.activity.tool.fileList",
        "generate_pdf": "conversation.activity.tool.pdf",
    ]

    static func toolLabel(_ name: String) -> String {
        friendlyTools[name].map { L($0) } ?? name
    }

    private static func toolList(_ names: [String]) -> String {
        var seen: [String] = []
        for name in names where !seen.contains(name) { seen.append(name) }
        return seen.map(toolLabel).joined(separator: ", ")
    }

    static func phaseLabel(_ id: ActivityPhaseID, view: ActivityView) -> String {
        if id == .search {
            let families = view.beats.compactMap { beat -> ActivityToolFamily? in
                if case .tools(let family, _, _, _, _, _, _) = beat.kind { return family }
                return nil
            }
            let onlySearch = !families.isEmpty && families.allSatisfy { $0 == .search }
            return L(onlySearch ? "conversation.activity.phase.search" : "conversation.activity.phase.tools")
        }
        return L("conversation.activity.phase.\(id.rawValue)")
    }

    /// The bold one-line title of a story beat.
    static func beatTitle(_ beat: ActivityBeat) -> String {
        switch beat.kind {
        case .memory(let core, let recalled, _, _):
            if core + recalled == 0 { return L("conversation.activity.beat.memoryNone") }
            if recalled > 0 { return L("conversation.activity.beat.memoryRecalled", ["core": core, "recalled": recalled]) }
            return L("conversation.activity.beat.memoryCore", ["count": core])
        case .plan(let round, _, let requests, let family):
            let count = requests.count
            switch family {
            case .search:
                return L(round > 1 ? "conversation.activity.beat.planMoreSearches" : "conversation.activity.beat.planSearches",
                         ["count": count])
            case .subagent: return L("conversation.activity.beat.planDelegate", ["count": count])
            case .plan: return L("conversation.activity.beat.planPlan")
            default: return L("conversation.activity.beat.planTools", ["tools": toolList(requests.map(\.name))])
            }
        case .tools(let family, let calls, _, _, _, _, _):
            let count = calls.count
            switch family {
            case .search: return L("conversation.activity.beat.toolsSearch", ["count": count])
            case .knowledge: return L("conversation.activity.beat.toolsKnowledge", ["count": count])
            case .subagent: return L("conversation.activity.beat.toolsSubagent", ["count": count])
            case .plan: return L("conversation.activity.beat.toolsPlan")
            case .files: return L("conversation.activity.beat.toolsFiles")
            case .other: return L("conversation.activity.beat.toolsOther", ["count": count, "tools": toolList(calls.map(\.name))])
            }
        case .read(let sourcesRead):
            return sourcesRead > 0
                ? L("conversation.activity.beat.read", ["count": sourcesRead])
                : L("conversation.activity.beat.readNone")
        case .answer(let outcome, let citedSources):
            if outcome == "structured" { return L("conversation.activity.beat.answerStructured") }
            return citedSources.isEmpty
                ? L("conversation.activity.beat.answer")
                : L("conversation.activity.beat.answerFromSources", ["count": citedSources.count])
        case .thinking(let writing, _):
            let doing = writing ? "Writing" : "Thinking"
            if beat.status == .stopped { return L("conversation.activity.beat.stopped\(doing)") }
            if beat.status == .failed { return L("conversation.activity.beat.failed\(doing)") }
            return L(writing ? "conversation.activity.beat.writing" : "conversation.activity.beat.thinking")
        case .output(let name, let summary):
            return summary ?? L("conversation.activity.beat.output", ["name": name])
        case .empty(let name):
            return L("conversation.activity.beat.empty", ["name": name])
        case .input:
            return L("conversation.activity.beat.input")
        }
    }

    /// What the agent is doing right now, for the live header ("searching: …").
    static func currentLabel(_ current: ActivityCurrent?) -> String? {
        switch current {
        case .none: return nil
        case .memory: return L("conversation.activity.current.memory")
        case .thinking: return L("conversation.activity.current.thinking")
        case .writing: return L("conversation.activity.current.writing")
        case .search(let query):
            return query.map { L("conversation.activity.current.searchQuery", ["query": $0]) }
                ?? L("conversation.activity.current.search")
        case .tool(let name): return L("conversation.activity.current.tool", ["tool": toolLabel(name)])
        case .input: return L("conversation.activity.current.input")
        }
    }

    /// The collapsed header: "Thought for 22s · 6 searches · 31 sources, 6 cited".
    static func header(_ view: ActivityView) -> (title: String, summary: [String]) {
        let time = duration(view.totalMs)
        var summary: [String] = []
        let title: String
        switch view.status {
        case .live:
            if !time.isEmpty { summary.append(time) }
            if let now = currentLabel(view.current) { summary.append(now) }
            return (L("conversation.activity.header.thinking"), summary)
        case .failed:
            title = time.isEmpty ? L("conversation.activity.header.failed") : L("conversation.activity.header.failedAfter", ["time": time])
        case .stopped:
            title = time.isEmpty ? L("conversation.activity.header.stopped") : L("conversation.activity.header.stoppedAfter", ["time": time])
        case .done:
            title = time.isEmpty ? L("conversation.activity.header.thought") : L("conversation.activity.header.thoughtFor", ["time": time])
        }
        if view.searchesUsed > 0 {
            summary.append(L("conversation.activity.header.searches", ["count": view.searchesUsed]))
        }
        if view.sourcesFound > 0 {
            if let cited = view.sourcesCited {
                summary.append(L("conversation.activity.header.sourcesCited", ["count": view.sourcesFound, "cited": cited]))
            } else {
                summary.append(L("conversation.activity.header.sources", ["count": view.sourcesFound]))
            }
        }
        return (title, summary)
    }
}

extension AppTheme {
    /// A recessed surface for nested boxes that reads on both card colours.
    static let activityWell = dynamic(light: "#F5F5F5", dark: "#2C2C2E")

    /// The panel's time phases; the same validated palettes as the web tokens.
    static func activityPhase(_ id: ActivityPhaseID) -> Color {
        switch id {
        case .setup: return border
        case .memory: return dynamic(light: "#006BE8", dark: "#0A84FF")
        case .plan: return dynamic(light: "#B3680A", dark: "#C47A10")
        case .search: return dynamic(light: "#8A3FC4", dark: "#A04ED8")
        case .reason: return dynamic(light: "#1D8A3A", dark: "#22A040")
        case .answer: return dynamic(light: "#1A7FA8", dark: "#2A9AC4")
        }
    }
}
