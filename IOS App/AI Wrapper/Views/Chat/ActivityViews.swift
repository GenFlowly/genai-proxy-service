import SwiftUI

/// The agent's activity for one response (ActivityPanel.tsx): what it thought, what it ran
/// and why, what came back, how long each step took, and which sources the answer rests
/// on. Open for the whole live turn (it never reacts to the answer text, so a tool-call
/// preamble can't collapse it), folded to one summary line once the turn ends.
struct ActivityPanel: View {
    let events: [ActivityEvent]
    let isLive: Bool
    var citedSources: [WebSource]?
    var stopReason: String?

    @State private var open: Bool
    @State private var mode: Mode = .story
    @State private var filter: EvidenceFilter?
    @State private var focusedBeat: String?
    @State private var focusedStep: String?
    /// The newest event's `at` and when it arrived, so the live clock runs on the
    /// server's timeline and never behind the events it shows.
    @State private var anchor: (at: Int, date: Date) = (0, Date())

    enum Mode { case story, evidence }

    init(events: [ActivityEvent], isLive: Bool, citedSources: [WebSource]? = nil, stopReason: String? = nil) {
        self.events = events
        self.isLive = isLive
        self.citedSources = citedSources
        self.stopReason = stopReason
        _open = State(initialValue: isLive)
        #if DEBUG
        // Headless capture: open every panel on a view via `-activityPanel story|evidence`.
        switch UserDefaults.standard.string(forKey: "activityPanel") {
        case "story": _open = State(initialValue: true)
        case "evidence":
            _open = State(initialValue: true)
            _mode = State(initialValue: .evidence)
        default: break
        }
        #endif
    }

    private var lastAt: Int { events.compactMap(\.at).max() ?? 0 }

    var body: some View {
        Group {
            if isLive {
                SwiftUI.TimelineView(.periodic(from: .now, by: 0.25)) { context in
                    content(now: anchor.at + Int(context.date.timeIntervalSince(anchor.date) * 1000))
                }
            } else {
                content(now: nil)
            }
        }
        .onAppear { anchor = (lastAt, Date()) }
        .onChange(of: lastAt) { _, newValue in anchor = (newValue, Date()) }
        .onChange(of: isLive) { wasLive, live in
            if live && !wasLive { open = true }
            if !live && wasLive { open = false }
        }
    }

    @ViewBuilder private func content(now: Int?) -> some View {
        let view = reduceActivity(events, isLive: isLive, nowMs: now, stopReason: stopReason,
                                  citedFallback: citedSources?.map(\.index))
        if !(view.isEmpty && !isLive) {
            VStack(alignment: .leading, spacing: 12) {
                ActivityHeader(view: view, open: open) { open.toggle() }
                if open {
                    if view.hasReceipt { ActivityReceipt(view: view) }
                    if !view.isEmpty {
                        tabs(view)
                        switch mode {
                        case .story:
                            ActivityStory(view: view, focusedBeat: focusedBeat) { stepId in
                                filter = .all
                                jump(to: .evidence, beat: nil, step: stepId)
                            }
                        case .evidence:
                            ActivityEvidence(view: view, filter: filter ?? defaultFilter(view),
                                             focusedStep: focusedStep,
                                             onFilter: { filter = $0 },
                                             onShowInStory: { jump(to: .story, beat: $0, step: nil) })
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L("conversation.activity.panelLabel"))
            .accessibilityIdentifier("activity-panel")
        }
    }

    private func defaultFilter(_ view: ActivityView) -> EvidenceFilter {
        (view.sourcesCited ?? 0) > 0 ? .cited : .all
    }

    private func jump(to target: Mode, beat: String?, step: String?) {
        mode = target
        focusedBeat = beat
        focusedStep = step
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            focusedBeat = nil
            focusedStep = nil
        }
    }

    private func tabs(_ view: ActivityView) -> some View {
        HStack(spacing: 3) {
            tab(L("conversation.activity.view.story"), count: view.beats.count, selected: mode == .story) { mode = .story }
                .accessibilityIdentifier("activity-tab-story")
            tab(L("conversation.activity.view.evidence"), count: view.sourcesFound, selected: mode == .evidence) { mode = .evidence }
                .accessibilityIdentifier("activity-tab-evidence")
        }
        .padding(3)
        .background(AppTheme.activityWell)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func tab(_ title: String, count: Int, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title).webText(13, lineHeight: 18.85)
                    .foregroundStyle(selected ? AppTheme.textPrimary : AppTheme.textSecondary)
                CountBadge(count: count)
            }
            .frame(maxWidth: .infinity, minHeight: 30)
            .background(selected ? AppTheme.backgroundSelected : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? AppTheme.primary : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

private struct CountBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .webText(11, lineHeight: 15.95)
            .monospacedDigit()
            .foregroundStyle(AppTheme.textMuted)
            .padding(.horizontal, 6)
            .background(AppTheme.backgroundTertiary)
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Header

private struct ActivityHeader: View {
    let view: ActivityView
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        let parts = ActivityFormat.header(view)
        Button(action: toggle) {
            HStack(alignment: .top, spacing: 8) {
                switch view.status {
                case .live:
                    PulseDot(size: 8, color: AppTheme.primary).padding(.top, 6)
                case .done:
                    CheckMark(size: 14, lineWidth: 2.4).foregroundStyle(AppTheme.success).padding(.top, 3)
                default:
                    EmptyView()
                }
                parts.summary.reduce(Text(parts.title).font(DSFont.roboto(14, 500)).foregroundColor(AppTheme.textPrimary)) { text, part in
                    text + Text(" · \(part)").font(DSFont.roboto(14)).foregroundColor(AppTheme.textMuted)
                }
                .webText(14, lineHeight: 20.3)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                Chevron(expanded: open).padding(.top, 4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L(open ? "conversation.activity.header.hide" : "conversation.activity.header.show"))
        .accessibilityValue(([parts.title] + parts.summary).joined(separator: ", "))
        .accessibilityIdentifier("activity-header")
    }
}

/// lucide `check`, drawn: the web panel's done mark.
struct CheckMark: View {
    var size: CGFloat = 14
    var lineWidth: CGFloat = 2

    var body: some View {
        Path { path in
            path.move(to: CGPoint(x: 20, y: 6))
            path.addLine(to: CGPoint(x: 9, y: 17))
            path.addLine(to: CGPoint(x: 4, y: 12))
        }
        .applying(CGAffineTransform(scaleX: size / 24, y: size / 24))
        .stroke(style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
        .frame(width: size, height: size)
    }
}

// MARK: - Receipt

private struct ActivityReceipt: View {
    let view: ActivityView

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let searches = view.searchesMax.map { L("conversation.activity.tile.searchesOf", ["used": view.searchesUsed, "max": $0]) }
                ?? "\(view.searchesUsed)"
            let sourcesSub: String? = view.sourcesFound == 0 ? nil
                : view.sourcesCited.map { L("conversation.activity.tile.sourcesCited", ["count": $0]) }
                ?? (view.status == .live ? L("conversation.activity.tile.sourcesPending") : nil)
            let memoriesSub: String? = view.memoriesRecalled > 0
                ? L("conversation.activity.tile.memoriesSplit", ["recalled": view.memoriesRecalled, "core": view.memoriesCore]) : nil
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    ActivityTile(label: L("conversation.activity.tile.time"),
                                 value: ActivityFormat.duration(view.totalMs).isEmpty ? "–" : ActivityFormat.duration(view.totalMs),
                                 sub: nil, identifier: "activity-tile-time")
                    ActivityTile(label: L("conversation.activity.tile.searches"), value: searches, sub: nil,
                                 identifier: "activity-tile-searches")
                }
                .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    ActivityTile(label: L("conversation.activity.tile.sources"), value: "\(view.sourcesFound)", sub: sourcesSub,
                                 identifier: "activity-tile-sources")
                    ActivityTile(label: L("conversation.activity.tile.memories"), value: "\(view.memoriesCore + view.memoriesRecalled)",
                                 sub: memoriesSub, identifier: "activity-tile-memories")
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            let total = view.phases.reduce(0) { $0 + $1.ms }
            if total > 0 {
                PhaseBar(phases: view.phases, total: total)
                    .accessibilityElement()
                    .accessibilityLabel(L("conversation.activity.phase.barLabel", ["parts": view.phases.map {
                        "\(ActivityFormat.phaseLabel($0.id, view: view)) \(ActivityFormat.duration($0.ms))"
                    }.joined(separator: ", ")]))
                PhaseLegend(view: view)
            }
        }
        .accessibilityIdentifier("activity-receipt")
    }
}

/// StatTile with the panel's tighter padding on the recessed surface.
private struct ActivityTile: View {
    let label: String
    let value: String
    let sub: String?
    let identifier: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .webText(11, 600)
                .kerning(0.66)
                .foregroundStyle(AppTheme.textMuted)
                .lineLimit(1)
            Text(value)
                .webText(20, 500, lineHeight: 25)
                .monospacedDigit()
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
            if let sub {
                Text(sub).webText(12).foregroundStyle(AppTheme.textMuted)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.activityWell)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

private struct PhaseBar: View {
    let phases: [ActivityPhase]
    let total: Int

    var body: some View {
        GeometryReader { geo in
            let gaps = CGFloat(max(0, phases.count - 1)) * 2
            HStack(spacing: 2) {
                ForEach(phases, id: \.id) { phase in
                    PhaseSegment(color: AppTheme.activityPhase(phase.id), running: phase.running)
                        .frame(width: max(3, (geo.size.width - gaps) * CGFloat(phase.ms) / CGFloat(total)))
                }
            }
        }
        .frame(height: 10)
    }
}

private struct PhaseSegment: View {
    let color: Color
    let running: Bool
    @State private var dim = false

    var body: some View {
        RoundedRectangle(cornerRadius: 3)
            .fill(color)
            .opacity(running && dim ? 0.45 : 1)
            .onAppear {
                guard running else { return }
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}

private struct PhaseLegend: View {
    let view: ActivityView

    var body: some View {
        FlowLayout(spacing: 14, lineSpacing: 4) {
            ForEach(view.phases, id: \.id) { phase in
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).fill(AppTheme.activityPhase(phase.id)).frame(width: 8, height: 8)
                    Text(ActivityFormat.phaseLabel(phase.id, view: view)).foregroundStyle(AppTheme.textMuted)
                    Text(ActivityFormat.duration(phase.ms) + (phase.running ? "…" : ""))
                        .monospacedDigit()
                        .foregroundStyle(AppTheme.textPrimary)
                }
                .webText(11, lineHeight: 15.95)
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Story

private struct ActivityStory: View {
    let view: ActivityView
    let focusedBeat: String?
    let onShowEvidence: (String) -> Void

    var body: some View {
        let isLive = view.status == .live
        let longest = max(1, view.beats.compactMap(\.durationMs).max() ?? 1)
        let showPendingAnswer = isLive && !view.beats.contains { if case .answer = $0.kind { return true }; return false }
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(view.beats.enumerated()), id: \.element.id) { index, beat in
                BeatRow(beat: beat, index: index, view: view,
                        isLast: index == view.beats.count - 1 && !showPendingAnswer,
                        compact: !isLive,
                        barWidth: CGFloat(beat.durationMs ?? 0) / CGFloat(longest) * 60,
                        focused: focusedBeat == beat.id,
                        onShowEvidence: onShowEvidence)
            }
            if showPendingAnswer {
                HStack(alignment: .top, spacing: 10) {
                    Circle().strokeBorder(AppTheme.border, lineWidth: 2).frame(width: 18, height: 18)
                        .frame(width: 20)
                    Text(L("conversation.activity.beat.answer")).webText(14, 500, lineHeight: 20.3)
                        .foregroundStyle(AppTheme.textPrimary)
                }
                .opacity(0.55)
            }
        }
        .accessibilityIdentifier("activity-story")
    }
}

private func beatIcon(_ beat: ActivityBeat) -> String? {
    switch beat.kind {
    case .memory: return "lucide-book-open"
    case .tools(let family, _, _, _, _, _, _):
        switch family {
        case .search: return "lucide-globe"
        case .knowledge: return "lucide-file-search"
        case .subagent: return "lucide-sparkles"
        default: return "lucide-wrench"
        }
    case .answer: return nil
    default: return "lucide-brain"
    }
}

private func beatPhase(_ beat: ActivityBeat, index: Int, beats: [ActivityBeat]) -> ActivityPhaseID {
    switch beat.kind {
    case .memory: return .memory
    case .tools: return .search
    case .answer: return .answer
    case .plan:
        return beats.prefix(index).contains { if case .tools = $0.kind { return true }; return false } ? .reason : .plan
    case .input: return .setup
    default: return .reason
    }
}

private struct BeatRow: View {
    let beat: ActivityBeat
    let index: Int
    let view: ActivityView
    let isLast: Bool
    let compact: Bool
    let barWidth: CGFloat
    let focused: Bool
    let onShowEvidence: (String) -> Void

    @State private var open: Bool

    init(beat: ActivityBeat, index: Int, view: ActivityView, isLast: Bool, compact: Bool, barWidth: CGFloat,
         focused: Bool, onShowEvidence: @escaping (String) -> Void) {
        self.beat = beat
        self.index = index
        self.view = view
        self.isLast = isLast
        self.compact = compact
        self.barWidth = barWidth
        self.focused = focused
        self.onShowEvidence = onShowEvidence
        // Done turns fold to one line per beat, except the answer, whose cited sources
        // tie the research to the reply.
        if case .answer = beat.kind { _open = State(initialValue: true) } else { _open = State(initialValue: false) }
    }

    /// Memory texts are personal: they open on request even while live, so they never
    /// sit on screen during a turn (a shared screen, a demo).
    private var onDemand: Bool {
        if case .memory = beat.kind { return true }
        return compact
    }

    private var hasDetail: Bool {
        switch beat.kind {
        case .memory(_, _, let core, let recalled): return (core?.count ?? 0) + (recalled?.count ?? 0) > 0
        case .plan(_, let reasoning, _, _): return reasoning != nil
        case .tools(_, let calls, _, _, _, _, let todos): return !calls.isEmpty || !(todos ?? []).isEmpty
        case .answer(_, let cited): return !cited.isEmpty
        default: return false
        }
    }

    private var showDetail: Bool { !onDemand || open || focused }

    private var statusWord: String? {
        if case .thinking = beat.kind { return nil }
        switch beat.status {
        case .stopped: return L("conversation.activity.status.stopped")
        case .failed: return L("conversation.activity.status.failed")
        default: return nil
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                RailDot(status: beat.status)
                if !isLast {
                    Rectangle().fill(AppTheme.border).frame(width: 2).padding(.vertical, 3)
                }
            }
            .frame(width: 20)

            VStack(alignment: .leading, spacing: 6) {
                if onDemand && hasDetail {
                    Button { open.toggle() } label: { head }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("activity-beat-toggle")
                } else {
                    head
                }
                if showDetail { BeatDetail(beat: beat, onShowEvidence: onShowEvidence) }
            }
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(focused ? AppTheme.backgroundSelected : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .animation(.easeInOut(duration: 0.6), value: focused)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("activity-beat-\(beat.typeName)")
    }

    private var head: some View {
        HStack(spacing: 8) {
            if let icon = beatIcon(beat) {
                WebIcon(name: icon, size: 14, color: AppTheme.textMuted)
            } else {
                CheckMark(size: 14, lineWidth: 2).foregroundStyle(AppTheme.textMuted)
            }
            Text(ActivityFormat.beatTitle(beat))
                .webText(14, compact ? 400 : 500, lineHeight: 20.3)
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(compact ? 1 : nil)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let statusWord {
                Text(statusWord).webText(12).foregroundStyle(AppTheme.textMuted)
            }
            if compact, beat.durationMs != nil {
                HStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(AppTheme.activityPhase(beatPhase(beat, index: index, beats: view.beats)))
                        .frame(width: max(3, barWidth.rounded()), height: 6)
                    Spacer(minLength: 0)
                }
                .frame(width: 60)
            }
            let time = ActivityFormat.duration(beat.durationMs)
            if !time.isEmpty {
                Text(time).webText(12).monospacedDigit()
                    .foregroundStyle(beat.status == .running ? AppTheme.textPrimary : AppTheme.textMuted)
            }
            if onDemand && hasDetail {
                Chevron(expanded: showDetail)
            } else if onDemand {
                // Keeps the time bars aligned with the rows that can open.
                Color.clear.frame(width: 12, height: 12)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct RailDot: View {
    let status: ActivityStepStatus

    var body: some View {
        switch status {
        case .running:
            Circle().fill(AppTheme.backgroundSelected).frame(width: 18, height: 18)
                .overlay(PulseDot(size: 8, color: AppTheme.primary))
        case .done:
            Circle().fill(AppTheme.backgroundSelected).frame(width: 18, height: 18)
                .overlay(CheckMark(size: 11, lineWidth: 3).foregroundStyle(AppTheme.success))
        default:
            Circle().strokeBorder(AppTheme.border, lineWidth: 2).frame(width: 18, height: 18)
        }
    }
}

private struct BeatDetail: View {
    let beat: ActivityBeat
    let onShowEvidence: (String) -> Void

    var body: some View {
        switch beat.kind {
        case .memory(_, _, let core, let recalled):
            MemoryTexts(core: core ?? [], recalled: recalled ?? [])
        case .plan(_, let reasoning, _, _):
            if let reasoning {
                Text("“\(reasoning)”")
                    .webText(13, lineHeight: 18.85, italic: true)
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .tools(let family, let calls, _, let cited, let used, let max, let todos):
            ToolsDetail(stepId: beat.id, family: family, calls: calls, cited: cited, budgetUsed: used,
                        budgetMax: max, todos: todos, onShowEvidence: onShowEvidence)
        case .answer(_, let citedSources):
            if !citedSources.isEmpty {
                FlowLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(citedSources) { source in
                        Link(destination: URL(string: source.source.url) ?? AppConfig.webAppURL) {
                            HStack(spacing: 5) {
                                SiteIcon(url: source.source.url, favicon: source.source.favicon, size: 14)
                                Text("[\(source.source.index)] \(source.domain)")
                                    .webText(11, lineHeight: 15.95)
                                    .foregroundStyle(AppTheme.textSecondary)
                            }
                            .padding(.leading, 4)
                            .padding(.trailing, 8)
                            .padding(.vertical, 2)
                            .background(AppTheme.activityWell)
                            .clipShape(Capsule())
                        }
                    }
                }
                .padding(.leading, 22)
                .accessibilityIdentifier("activity-answer-sources")
            }
        default:
            EmptyView()
        }
    }
}

struct MemoryTexts: View {
    let core: [String]
    let recalled: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            group(L("conversation.activity.evidence.recalledLabel"), recalled)
            group(L("conversation.activity.evidence.coreLabel"), core)
        }
        .accessibilityIdentifier("activity-memory-texts")
    }

    @ViewBuilder private func group(_ label: String, _ items: [String]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).webText(11, lineHeight: 15.95).foregroundStyle(AppTheme.textMuted)
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").webText(13)
                        Text(item).webText(13, lineHeight: 18.85)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .foregroundStyle(AppTheme.textSecondary)
                    .padding(.leading, 6)
                }
            }
        }
    }
}

private struct ToolsDetail: View {
    let stepId: String
    let family: ActivityToolFamily
    let calls: [ActivityCallView]
    let cited: Int?
    let budgetUsed: Int?
    let budgetMax: Int?
    let todos: [TodoItem]?
    let onShowEvidence: (String) -> Void

    private static let previewSources = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let todos, !todos.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(todo.status == "completed" ? "☑" : (todo.status == "in_progress" ? "◐" : "☐")).webText(13)
                            Text(todo.content)
                                .webText(13, todo.status == "in_progress" ? 600 : 400)
                                .strikethrough(todo.status == "completed")
                                .opacity(todo.status == "completed" ? 0.6 : 1)
                        }
                        .foregroundStyle(AppTheme.textSecondary)
                    }
                }
            }
            if !calls.isEmpty {
                let total = calls.reduce(0) { $0 + $1.sources.count }
                let hidden = calls.reduce(0) { $0 + max(0, $1.sources.count - Self.previewSources) }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(calls.enumerated()), id: \.element.id) { index, call in
                        if index > 0 { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
                        CallRow(call: call, previewCount: Self.previewSources)
                    }
                    if total > 0 {
                        HStack(spacing: 8) {
                            if let cited {
                                Text(L("conversation.activity.evidence.stepSummary", ["found": total, "cited": cited]))
                            } else if hidden > 0 {
                                Text(L("conversation.activity.beat.moreResults", ["count": hidden]))
                            }
                            Spacer(minLength: 0)
                            Button { onShowEvidence(stepId) } label: {
                                Text(L("conversation.activity.beat.moreInEvidence", ["count": total]))
                                    .foregroundStyle(AppTheme.primary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("activity-show-evidence")
                        }
                        .webText(12)
                        .foregroundStyle(AppTheme.textMuted)
                        .padding(.leading, 21)
                    }
                    if family == .search, let budgetUsed, let budgetMax {
                        Text(L("conversation.activity.beat.budget", ["used": budgetUsed, "max": budgetMax]))
                            .webText(12)
                            .foregroundStyle(AppTheme.textMuted)
                            .padding(.leading, 21)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AppTheme.activityWell)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("activity-calls")
            }
        }
    }
}

private struct CallRow: View {
    let call: ActivityCallView
    let previewCount: Int

    private var meta: String? {
        switch call.status {
        case .running: return L("conversation.activity.call.running")
        case .stopped: return L("conversation.activity.call.stopped")
        case .done:
            let parts = [
                call.resultCount.map { $0 > 0 ? L("conversation.activity.call.results", ["count": $0]) : L("conversation.activity.call.noResults") },
                call.durationMs.map { ActivityFormat.duration($0) },
            ].compactMap { $0 }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        default: return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                switch call.status {
                case .running:
                    PulseDot(size: 8, color: AppTheme.primary).padding(.top, 4).padding(.horizontal, 2)
                case .done:
                    CheckMark(size: 13, lineWidth: 2).foregroundStyle(AppTheme.success).padding(.top, 2)
                default:
                    WebIcon(name: "search", size: 13, color: AppTheme.textMuted).padding(.top, 2)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(call.query ?? call.name).webText(13, lineHeight: 18.85).foregroundStyle(AppTheme.textPrimary)
                    if let purpose = call.purpose {
                        Text(purpose).webText(12, lineHeight: 17.4).foregroundStyle(AppTheme.textMuted)
                    }
                    switch call.status {
                    case .skipped:
                        Text(L("conversation.activity.call.skipped")).webText(12).foregroundStyle(AppTheme.textMuted)
                    case .denied:
                        Text(L("conversation.activity.call.denied")).webText(12).foregroundStyle(AppTheme.textMuted)
                    case .failed:
                        Text(L("conversation.activity.call.failed", ["error": call.error ?? ""])).webText(12).foregroundStyle(AppTheme.error)
                    default:
                        EmptyView()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let meta {
                    Text(meta).webText(11).monospacedDigit().foregroundStyle(AppTheme.textMuted).lineLimit(1)
                }
            }
            let preview = Array(call.sources.prefix(previewCount))
            if !preview.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(preview) { source in SourceRow(source: source, variant: .compact) }
                }
                .padding(.leading, 21)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("activity-call")
    }
}

// MARK: - Sources

/// The site's own icon, or its first letter when there is none or it fails to load.
struct SiteIcon: View {
    let url: String
    let favicon: String?
    var size: CGFloat = 16

    var body: some View {
        let monogram = Text(ActivityFormat.monogram(activityDomain(url)))
            .font(DSFont.roboto(size * 0.625, 700))
            .foregroundStyle(AppTheme.textPrimary)
            .frame(width: size, height: size)
            .background(AppTheme.backgroundHover)
            .clipShape(RoundedRectangle(cornerRadius: size / 4))
        if let iconURL = ActivityFormat.usableFavicon(favicon) {
            AsyncImage(url: iconURL) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFit()
                        .frame(width: size, height: size)
                        .clipShape(RoundedRectangle(cornerRadius: size / 4))
                } else {
                    monogram
                }
            }
            .frame(width: size, height: size)
        } else {
            monogram
        }
    }
}

struct SourceRow: View {
    enum Variant { case compact, ledger }

    let source: ActivitySourceView
    var variant: Variant = .compact
    var meta: String?

    var body: some View {
        let title = source.source.title.isEmpty ? source.source.url : source.source.title
        let link = URL(string: source.source.url) ?? AppConfig.webAppURL
        switch variant {
        case .compact:
            HStack(spacing: 8) {
                SiteIcon(url: source.source.url, favicon: source.source.favicon)
                Text(source.domain).webText(12).foregroundStyle(AppTheme.textMuted).lineLimit(1).fixedSize()
                Link(destination: link) {
                    Text(title).webText(13).foregroundStyle(AppTheme.textSecondary).lineLimit(1).truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if source.cited == true { citedBadge }
            }
            .opacity(source.cited == false ? 0.7 : 1)
            .accessibilityIdentifier("activity-source")
        case .ledger:
            let line = [source.domain, ActivityFormat.sourceDate(source.source.publishedDate), meta].compactMap { $0 }.joined(separator: " · ")
            HStack(spacing: 10) {
                if source.cited == true {
                    Link(destination: link) {
                        Text("[\(source.source.index)]").webText(11).monospacedDigit()
                            .foregroundStyle(AppTheme.textPrimary)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(AppTheme.backgroundSelected)
                            .clipShape(Capsule())
                            .overlay(Capsule().strokeBorder(AppTheme.primary, lineWidth: 1))
                    }
                }
                SiteIcon(url: source.source.url, favicon: source.source.favicon, size: 20)
                VStack(alignment: .leading, spacing: 0) {
                    Link(destination: link) {
                        Text(title).webText(13, lineHeight: 18.85).foregroundStyle(AppTheme.textSecondary)
                            .lineLimit(1).truncationMode(.tail)
                    }
                    Text(line).webText(11, lineHeight: 15.95).foregroundStyle(AppTheme.textMuted).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 8)
            .overlay(alignment: .top) { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
            .accessibilityIdentifier("activity-evidence-source")
        }
    }

    private var citedBadge: some View {
        Text(L("conversation.activity.evidence.citedBadge", ["index": source.source.index]))
            .webText(11)
            .foregroundStyle(AppTheme.textPrimary)
            .padding(.horizontal, 7).padding(.vertical, 1)
            .background(AppTheme.backgroundSelected)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(AppTheme.primary, lineWidth: 1))
            .fixedSize()
    }
}

// MARK: - Evidence

enum EvidenceFilter: String { case all, cited, notCited, failed }

private struct ActivityEvidence: View {
    let view: ActivityView
    let filter: EvidenceFilter
    let focusedStep: String?
    let onFilter: (EvidenceFilter) -> Void
    let onShowInStory: (String) -> Void

    var body: some View {
        let citationsKnown = view.sourcesCited != nil
        let all = view.evidence.flatMap(\.sources)
        let active: EvidenceFilter = (!citationsKnown && (filter == .cited || filter == .notCited)) ? .all : filter
        let groups = view.evidence.filter { !$0.calls.isEmpty }
        VStack(alignment: .leading, spacing: 12) {
            if !groups.isEmpty {
                FlowLayout(spacing: 6, lineSpacing: 6) {
                    chip(.all, L("conversation.activity.evidence.all", ["count": all.count]), active)
                    if citationsKnown {
                        chip(.cited, L("conversation.activity.evidence.cited", ["count": all.filter { $0.cited == true }.count]), active)
                        chip(.notCited, L("conversation.activity.evidence.notCited", ["count": all.filter { $0.cited == false }.count]), active)
                    }
                    chip(.failed, L("conversation.activity.evidence.failed", ["count": view.evidence.reduce(0) { $0 + $1.failedCalls.count }]), active)
                }
                .accessibilityIdentifier("activity-evidence-filter")
            } else {
                Text(L("conversation.activity.evidence.noSources")).webText(13).foregroundStyle(AppTheme.textMuted)
            }
            ForEach(groups) { group in
                EvidenceGroupView(group: group, filter: active,
                                  stepNumber: (view.beats.firstIndex { $0.id == group.beatId } ?? -1) + 1,
                                  beat: view.beats.first { $0.id == group.beatId },
                                  focused: focusedStep == group.stepId,
                                  onShowInStory: onShowInStory)
            }
            VStack(alignment: .leading, spacing: 8) {
                MemorySection(view: view)
                if !view.developer.isEmpty { DeveloperSection(entries: view.developer) }
            }
            .padding(.top, 10)
            .overlay(alignment: .top) { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
        }
        .accessibilityIdentifier("activity-evidence")
    }

    private func chip(_ id: EvidenceFilter, _ label: String, _ active: EvidenceFilter) -> some View {
        let on = id == active
        return Button { onFilter(id) } label: {
            Text(label).webText(12).monospacedDigit()
                .foregroundStyle(on ? AppTheme.textPrimary : AppTheme.textSecondary)
                .padding(.horizontal, 10).padding(.vertical, 3)
                .background(on ? AppTheme.backgroundSelected : AppTheme.activityWell)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(on ? AppTheme.primary : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
    }
}

private struct EvidenceGroupView: View {
    let group: ActivityEvidenceGroup
    let filter: EvidenceFilter
    let stepNumber: Int
    let beat: ActivityBeat?
    let focused: Bool
    let onShowInStory: (String) -> Void

    @State private var showNotCited = false

    private enum Row: Identifiable {
        case source(ActivitySourceView)
        case failed(ActivityCallView)

        var id: String {
            switch self {
            case .source(let s): return "s-\(s.source.index)"
            case .failed(let c): return "f-\(c.key)"
            }
        }
    }

    private func rows(_ filter: EvidenceFilter) -> [Row] {
        let sources = group.sources.map(Row.source)
        let failed = group.failedCalls.map(Row.failed)
        switch filter {
        case .cited: return group.sources.filter { $0.cited == true }.map(Row.source)
        case .notCited: return group.sources.filter { $0.cited == false }.map(Row.source)
        case .failed: return failed
        case .all: return sources + failed
        }
    }

    var body: some View {
        let visibleRows = rows(filter)
        let notCited = filter == .cited ? rows(.notCited) : []
        let shown = showNotCited ? visibleRows + notCited : visibleRows
        if !(shown.isEmpty && notCited.isEmpty && filter != .all) {
            VStack(alignment: .leading, spacing: 0) {
                Button { onShowInStory(group.beatId) } label: {
                    HStack(spacing: 8) {
                        if stepNumber > 0 {
                            Text(L("conversation.activity.evidence.step", ["n": stepNumber])).webText(11).foregroundStyle(AppTheme.textMuted)
                        }
                        Text(beat.map(ActivityFormat.beatTitle) ?? group.stepId)
                            .webText(13, 500).foregroundStyle(AppTheme.textPrimary).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(metaLine).webText(11).foregroundStyle(AppTheme.textMuted).lineLimit(1).fixedSize()
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                ForEach(shown) { row in
                    switch row {
                    case .source(let source):
                        SourceRow(source: source, variant: .ledger,
                                  meta: L("conversation.activity.evidence.query", ["seq": source.callSeq]))
                    case .failed(let call):
                        VStack(alignment: .leading, spacing: 2) {
                            Text(call.query ?? call.name).webText(13).foregroundStyle(AppTheme.textPrimary)
                            Text(failureText(call)).webText(12)
                                .foregroundStyle(call.status == .failed ? AppTheme.error : AppTheme.textMuted)
                        }
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .top) { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
                    }
                }
                if !notCited.isEmpty && !showNotCited {
                    Button { showNotCited = true } label: {
                        Text(L("conversation.activity.evidence.showNotCited", ["count": notCited.count]))
                            .webText(12).foregroundStyle(AppTheme.primary)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                }
            }
            .background(focused ? AppTheme.backgroundSelected : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .animation(.easeInOut(duration: 0.6), value: focused)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("activity-evidence-group")
        }
    }

    private var metaLine: String {
        let found = group.cited.map { L("conversation.activity.evidence.stepSummary", ["found": group.found, "cited": $0]) }
            ?? L("conversation.activity.evidence.stepFound", ["count": group.found])
        let time = ActivityFormat.duration(group.durationMs)
        return time.isEmpty ? found : "\(found) · \(time)"
    }

    private func failureText(_ call: ActivityCallView) -> String {
        switch call.status {
        case .failed: return L("conversation.activity.call.failed", ["error": call.error ?? ""])
        case .skipped: return L("conversation.activity.call.skipped")
        default: return L("conversation.activity.call.denied")
        }
    }
}

private struct MemorySection: View {
    let view: ActivityView
    @State private var open = false

    var body: some View {
        let total = view.memoriesCore + view.memoriesRecalled
        VStack(alignment: .leading, spacing: 8) {
            Button { if total > 0 { open.toggle() } } label: {
                HStack(spacing: 8) {
                    if total > 0 { Chevron(expanded: open) }
                    Text(L("conversation.activity.evidence.memory", ["count": total])).webText(13).foregroundStyle(AppTheme.textSecondary)
                    if total > 0 {
                        Text(L("conversation.activity.evidence.memorySplit", ["core": view.memoriesCore, "recalled": view.memoriesRecalled]))
                            .webText(12).foregroundStyle(AppTheme.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
            if open {
                if view.memoryTextsCore != nil || view.memoryTextsRecalled != nil {
                    MemoryTexts(core: view.memoryTextsCore ?? [], recalled: view.memoryTextsRecalled ?? [])
                } else {
                    Text(L("conversation.activity.beat.memoryRedacted")).webText(13).foregroundStyle(AppTheme.textMuted)
                        .accessibilityIdentifier("activity-memory-redacted")
                }
            }
        }
        .accessibilityIdentifier("activity-memory-section")
    }
}

private struct DeveloperSection: View {
    let entries: [ActivityDeveloperEntry]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { open.toggle() } label: {
                HStack(spacing: 8) {
                    Chevron(expanded: open)
                    Text(L("conversation.activity.evidence.developer")).webText(13).foregroundStyle(AppTheme.textSecondary)
                    Text(L("conversation.activity.evidence.developerSub")).webText(12).foregroundStyle(AppTheme.textMuted)
                }
            }
            .buttonStyle(.plain)
            if open {
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.name).webText(11).foregroundStyle(AppTheme.textMuted)
                        if let prompt = entry.prompt { block(L("conversation.activity.evidence.prompt"), prompt) }
                        if let response = entry.response { block(L("conversation.activity.evidence.response"), response) }
                    }
                }
            }
        }
        .accessibilityIdentifier("activity-developer-section")
    }

    private func block(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).webText(11).foregroundStyle(AppTheme.textMuted)
            ScrollView {
                Text(text).webText(mono: 12, lineHeight: 17.4).foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).padding(.vertical, 8)
            }
            .frame(maxHeight: 256)
            .background(AppTheme.activityWell)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(AppTheme.borderLight, lineWidth: 1))
        }
    }
}
