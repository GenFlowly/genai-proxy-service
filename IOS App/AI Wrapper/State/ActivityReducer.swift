import Foundation

/// activity log → what the panel shows. A port of the component library's
/// activity.reduce.ts: the same events (and the same clock) give the same view on
/// both platforms, checked against the shared fixtures in ActivityReducerTests.

enum ActivityTurnStatus: Equatable { case live, done, stopped, failed }
enum ActivityStepStatus: Equatable { case running, done, stopped, failed }
enum ActivityPhaseID: String, CaseIterable { case setup, memory, plan, search, reason, answer }
enum ActivityToolFamily: Equatable { case search, knowledge, subagent, plan, files, other }
enum ActivityCallStatus: Equatable { case running, done, skipped, denied, failed, stopped }

struct ActivityPhase: Equatable {
    var id: ActivityPhaseID
    var ms: Int
    var running: Bool
}

struct ActivitySourceView: Equatable, Identifiable {
    var source: ActivitySource
    var domain: String
    /// nil while the turn runs: citations are only known once the answer exists.
    var cited: Bool?
    var stepId: String
    var callSeq: Int
    var query: String?

    var id: Int { source.index }
}

struct ActivityCallView: Equatable, Identifiable {
    var key: String
    var seq: Int
    var name: String
    var query: String?
    var purpose: String?
    var status: ActivityCallStatus
    var mode: String?
    var durationMs: Int?
    var resultCount: Int?
    var excerpt: String?
    var error: String?
    var sources: [ActivitySourceView]
    var hasDetails: Bool

    var id: String { key }
}

enum ActivityBeatKind: Equatable {
    case memory(core: Int, recalled: Int, textsCore: [String]?, textsRecalled: [String]?)
    case plan(round: Int, reasoning: String?, requests: [ActivityToolRequest], family: ActivityToolFamily)
    case tools(family: ActivityToolFamily, calls: [ActivityCallView], found: Int, cited: Int?,
               budgetUsed: Int?, budgetMax: Int?, todos: [TodoItem]?)
    case read(sourcesRead: Int)
    case answer(outcome: String, citedSources: [ActivitySourceView])
    case thinking(writing: Bool, name: String)
    case output(name: String, summary: String?)
    case empty(name: String)
    case input(interrupted: Bool)
}

struct ActivityBeat: Equatable, Identifiable {
    var id: String
    var status: ActivityStepStatus
    var durationMs: Int?
    var kind: ActivityBeatKind

    var typeName: String {
        switch kind {
        case .memory: return "memory"
        case .plan: return "plan"
        case .tools: return "tools"
        case .read: return "read"
        case .answer: return "answer"
        case .thinking: return "thinking"
        case .output: return "output"
        case .empty: return "empty"
        case .input: return "input"
        }
    }
}

struct ActivityEvidenceGroup: Equatable, Identifiable {
    var stepId: String
    var beatId: String
    var family: ActivityToolFamily
    var status: ActivityStepStatus
    var durationMs: Int?
    var calls: [ActivityCallView]
    var sources: [ActivitySourceView]
    var failedCalls: [ActivityCallView]
    var found: Int
    var cited: Int?

    var id: String { stepId }
}

struct ActivityDeveloperEntry: Equatable, Identifiable {
    var stepId: String
    var name: String
    var prompt: String?
    var response: String?

    var id: String { stepId }
}

enum ActivityCurrent: Equatable {
    case memory, thinking, writing, input
    case search(query: String?)
    case tool(name: String)
}

struct ActivityView: Equatable {
    var status: ActivityTurnStatus
    var isEmpty: Bool
    /// False when the receipt would only show blanks and zeros (history converted
    /// without timings, a plain answer with no tools or memories).
    var hasReceipt: Bool {
        status == .live || totalMs != nil || searchesUsed > 0 || sourcesFound > 0 || memoriesCore + memoriesRecalled > 0
    }
    var totalMs: Int?
    var phases: [ActivityPhase]
    var searchesUsed: Int
    var searchesMax: Int?
    var sourcesFound: Int
    var sourcesCited: Int?
    var memoriesCore: Int
    var memoriesRecalled: Int
    var memoryTextsCore: [String]?
    var memoryTextsRecalled: [String]?
    var beats: [ActivityBeat]
    var evidence: [ActivityEvidenceGroup]
    var developer: [ActivityDeveloperEntry]
    var current: ActivityCurrent?
}

private let searchTools: Set<String> = ["web_search"]
private let knowledgeTools: Set<String> = ["search_knowledge_base"]
private let subagentTools: Set<String> = ["spawn_agent"]
private let planTools: Set<String> = ["write_todos"]
private let fileTools: Set<String> = ["fs_read", "fs_write", "fs_list"]

func activityToolFamily(_ names: [String]) -> ActivityToolFamily {
    guard !names.isEmpty else { return .other }
    func all(_ set: Set<String>) -> Bool { names.allSatisfy(set.contains) }
    if all(searchTools) { return .search }
    if all(knowledgeTools) { return .knowledge }
    if all(subagentTools) { return .subagent }
    if all(planTools) { return .plan }
    if all(fileTools) { return .files }
    return .other
}

/// "docs.python.org" for https://docs.python.org/3/…; the raw url when unparsable.
func activityDomain(_ url: String) -> String {
    guard let host = URL(string: url)?.host, !host.isEmpty else { return url }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}

private final class StepRecord {
    let id: String
    let kind: String
    let node: String
    let name: String
    var startAt: Int?
    var firstTokenMs: Int?
    var end: ActivityEvent?
    var liveCalls: [String: ActivityToolCall] = [:]

    init(id: String, kind: String, node: String, name: String, startAt: Int?) {
        self.id = id
        self.kind = kind
        self.node = node
        self.name = name
        self.startAt = startAt
    }
}

/// - Parameters:
///   - nowMs: milliseconds since the turn started, on the server's clock (live only).
///   - stopReason: the message's stop reason; "cancelled" means the user stopped it.
///   - citedFallback: cited source indices for logs whose turn.end carries none.
func reduceActivity(
    _ events: [ActivityEvent],
    isLive: Bool,
    nowMs: Int? = nil,
    stopReason: String? = nil,
    citedFallback: [Int]? = nil
) -> ActivityView {
    var steps: [StepRecord] = []
    var byId: [String: StepRecord] = [:]
    var turnEnd: ActivityEvent?
    var lastAt = 0

    func stepFor(_ id: String, _ kind: String, _ node: String, _ name: String, _ at: Int?) -> StepRecord {
        if let existing = byId[id] { return existing }
        let step = StepRecord(id: id, kind: kind, node: node, name: name, startAt: at)
        byId[id] = step
        steps.append(step)
        return step
    }

    for event in events {
        if let at = event.at { lastAt = max(lastAt, at) }
        switch event.type {
        case .stepStart:
            guard let id = event.id else { continue }
            _ = stepFor(id, event.kind ?? "llm", event.node ?? id, event.name ?? id, event.at)
        case .stepProgress:
            if let id = event.id, let step = byId[id] { step.firstTokenMs = event.firstTokenMs }
        case .stepCall:
            if let id = event.id, let step = byId[id], let call = event.call {
                let key = call.id.flatMap { $0.isEmpty ? nil : $0 } ?? "seq-\(call.seq ?? step.liveCalls.count + 1)"
                step.liveCalls[key] = call
            }
        case .stepEnd:
            guard let id = event.id else { continue }
            let startAt = (event.at != nil && event.durationMs != nil) ? event.at! - event.durationMs! : nil
            let step = stepFor(id, event.kind ?? "llm", event.node ?? id, event.name ?? id, startAt)
            step.end = event
            if let first = event.firstTokenMs { step.firstTokenMs = first }
        case .turnEnd:
            turnEnd = event
        case .turnStart:
            break
        }
    }

    let status: ActivityTurnStatus
    if let turnEnd { status = turnEnd.turnOutcome == "error" ? .failed : .done }
    else if isLive { status = .live }
    else { status = .stopped }

    let now: Int? = status == .live ? max(nowMs ?? lastAt, lastAt) : nil
    let totalMs: Int? = turnEnd?.durationMs ?? (status == .live ? now : (lastAt > 0 ? lastAt : nil))

    let openStatus: ActivityStepStatus = status == .live ? .running : (status == .failed ? .failed : .stopped)
    func stepStatus(_ step: StepRecord) -> ActivityStepStatus {
        guard let end = step.end else { return openStatus }
        return end.interrupted ? .stopped : .done
    }
    func stepDuration(_ step: StepRecord) -> Int? {
        if let duration = step.end?.durationMs { return duration }
        guard let start = step.startAt else { return nil }
        let until = status == .live ? now! : (totalMs ?? lastAt)
        return max(0, until - start)
    }

    // Interim source lists hold every result, so citations come from turn.end; only a
    // finished turn's own source list may stand in for older records.
    let citedIndices: Set<Int>? = {
        if let cited = turnEnd?.cited { return Set(cited) }
        if status == .done, let fallback = citedFallback { return Set(fallback) }
        return nil
    }()
    func isCited(_ index: Int) -> Bool? { citedIndices.map { $0.contains(index) } }

    // Pair each tools step with the requests of the llm step that asked for it.
    var requestsFor: [String: [ActivityToolRequest]] = [:]
    var pending: [ActivityToolRequest] = []
    for step in steps {
        if step.kind == "llm", step.end?.outcome == "tool_calls" {
            pending = step.end?.toolCalls ?? []
        } else if step.kind == "tools" {
            requestsFor[step.id] = pending
            pending = []
        }
    }

    func callStatus(_ call: ActivityToolCall, _ stepStatus: ActivityStepStatus) -> ActivityCallStatus {
        if let error = call.error, !error.isEmpty { return .failed }
        if call.mode == "skip" { return .skipped }
        if call.mode == "exhausted" { return .denied }
        switch stepStatus {
        case .running, .done: return .done
        case .stopped: return .stopped
        case .failed: return .failed
        }
    }

    func callsOf(_ step: StepRecord) -> [ActivityCallView] {
        let st = stepStatus(step)
        let requests = requestsFor[step.id] ?? []
        if let end = step.end {
            return (end.calls ?? []).enumerated().map { offset, call in
                let seq = call.seq ?? offset + 1
                let query = call.arguments.mainArgument
                let purpose = call.arguments.purpose
                    ?? requests.first { $0.id == call.id }?.arguments.purpose
                let trimmedError = call.error?.trimmingCharacters(in: .whitespacesAndNewlines)
                return ActivityCallView(
                    key: (call.id?.isEmpty == false ? call.id! : "seq-\(seq)"),
                    seq: seq,
                    name: call.name,
                    query: query,
                    purpose: purpose,
                    status: callStatus(call, st),
                    mode: call.mode,
                    durationMs: call.durationMs,
                    resultCount: call.resultCount,
                    excerpt: call.resultExcerpt.flatMap { $0.isEmpty ? nil : $0 },
                    error: (trimmedError?.isEmpty == false) ? trimmedError : nil,
                    sources: call.sources.map { source in
                        ActivitySourceView(source: source, domain: activityDomain(source.url),
                                           cited: isCited(source.index), stepId: step.id,
                                           callSeq: seq, query: query)
                    },
                    hasDetails: call.hasDetails
                )
            }
        }
        // Running (or cut off): the requested calls, ticked off as they finish.
        return requests.enumerated().map { offset, request in
            let live = step.liveCalls[request.id] ?? step.liveCalls["seq-\(offset + 1)"]
            let seq = live?.seq ?? offset + 1
            var view = ActivityCallView(
                key: request.id.isEmpty ? "seq-\(seq)" : request.id,
                seq: seq,
                name: request.name,
                query: request.arguments.mainArgument,
                purpose: request.arguments.purpose,
                status: st == .running ? .running : (st == .failed ? .failed : (st == .done ? .done : .stopped)),
                sources: [],
                hasDetails: false
            )
            if let live {
                view.status = callStatus(live, .done)
                view.mode = live.mode
                view.durationMs = live.durationMs
                view.resultCount = live.resultCount
                view.error = live.error
            }
            return view
        }
    }

    let finalAnswer = steps.last { step in
        step.kind == "llm" && (step.end?.outcome == "answer" || step.end?.outcome == "structured")
    }

    var beats: [ActivityBeat] = []
    var evidence: [ActivityEvidenceGroup] = []
    var developer: [ActivityDeveloperEntry] = []
    var foundOrder: [Int] = []
    var foundSources: [Int: ActivitySourceView] = [:]
    var memoriesCore = 0
    var memoriesRecalled = 0
    var textsCore: [String]?
    var textsRecalled: [String]?
    var searchesUsed = 0
    var searchMax: Int?
    var toolRounds = 0
    var sawTools = false

    for step in steps {
        let st = stepStatus(step)
        let duration = stepDuration(step)
        let end = step.end
        if let end, end.developerPrompt != nil || end.developerResponse != nil {
            developer.append(ActivityDeveloperEntry(stepId: step.id, name: step.name,
                                                    prompt: end.developerPrompt, response: end.developerResponse))
        }

        switch step.kind {
        case "memory":
            let core = end?.countsCore ?? 0
            let recalled = end?.countsRecalled ?? 0
            memoriesCore += core
            memoriesRecalled += recalled
            if let end, end.memoriesCore != nil || end.memoriesRecalled != nil {
                textsCore = (textsCore ?? []) + (end.memoriesCore ?? [])
                textsRecalled = (textsRecalled ?? []) + (end.memoriesRecalled ?? [])
            }
            beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration,
                                      kind: .memory(core: core, recalled: recalled,
                                                    textsCore: end?.memoriesCore, textsRecalled: end?.memoriesRecalled)))
        case "input":
            beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration,
                                      kind: .input(interrupted: end?.interrupted ?? false)))
        case "tools":
            sawTools = true
            let calls = callsOf(step)
            for call in calls {
                // The backend's budget counts every search it dispatched; skipped and
                // denied calls never reached the provider.
                if searchTools.contains(call.name), call.status != .skipped, call.status != .denied {
                    searchesUsed += 1
                }
                for source in call.sources where foundSources[source.source.index] == nil {
                    foundSources[source.source.index] = source
                    foundOrder.append(source.source.index)
                }
            }
            if let max = end?.budgetMax { searchMax = max }
            let sources = calls.flatMap(\.sources)
            let citedCount = citedIndices == nil ? nil : sources.filter { $0.cited == true }.count
            let family = activityToolFamily(calls.map(\.name))
            beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration,
                                      kind: .tools(family: family, calls: calls, found: sources.count, cited: citedCount,
                                                   budgetUsed: end?.budgetUsed, budgetMax: end?.budgetMax, todos: end?.todos)))
            evidence.append(ActivityEvidenceGroup(
                stepId: step.id, beatId: step.id, family: family, status: st, durationMs: duration,
                calls: calls, sources: sources,
                failedCalls: calls.filter { $0.status == .failed || $0.status == .skipped || $0.status == .denied },
                found: sources.count, cited: citedCount))
        default:
            guard let end else {
                beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration,
                                          kind: .thinking(writing: step.firstTokenMs != nil, name: step.name)))
                continue
            }
            if end.outcome == "tool_calls" {
                toolRounds += 1
                let requests = end.toolCalls ?? []
                let reasoning = end.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines)
                beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration,
                                          kind: .plan(round: toolRounds,
                                                      reasoning: (reasoning?.isEmpty == false) ? reasoning : nil,
                                                      requests: requests,
                                                      family: activityToolFamily(requests.map(\.name)))))
            } else if step === finalAnswer {
                let first = step.firstTokenMs
                if sawTools, let first, let duration, first < duration {
                    beats.append(ActivityBeat(id: step.id + "#read", status: st, durationMs: first,
                                              kind: .read(sourcesRead: foundSources.count)))
                    beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration - first,
                                              kind: .answer(outcome: end.outcome ?? "answer", citedSources: [])))
                } else {
                    beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration,
                                              kind: .answer(outcome: end.outcome ?? "answer", citedSources: [])))
                }
            } else if end.outcome == "output" {
                let summary = end.summary?.trimmingCharacters(in: .whitespacesAndNewlines)
                beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration,
                                          kind: .output(name: step.name, summary: (summary?.isEmpty == false) ? summary : nil)))
            } else if end.outcome == "answer" || end.outcome == "structured" {
                beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration,
                                          kind: .output(name: step.name, summary: nil)))
            } else {
                beats.append(ActivityBeat(id: step.id, status: st, durationMs: duration, kind: .empty(name: step.name)))
            }
        }
    }

    let citedSources: [ActivitySourceView]? = citedIndices.map { indices in
        foundOrder.compactMap { foundSources[$0] }.filter { indices.contains($0.source.index) }
            .sorted { $0.source.index < $1.source.index }
    }
    if let citedSources {
        beats = beats.map { beat in
            guard case .answer(let outcome, _) = beat.kind else { return beat }
            var copy = beat
            copy.kind = .answer(outcome: outcome, citedSources: citedSources)
            return copy
        }
    }

    return ActivityView(
        status: status,
        isEmpty: steps.isEmpty,
        totalMs: totalMs,
        phases: phasesOf(steps, status: status, totalMs: totalMs, stepStatus: stepStatus,
                         stepDuration: stepDuration, finalAnswer: finalAnswer),
        searchesUsed: searchesUsed,
        searchesMax: searchMax,
        sourcesFound: foundSources.count,
        sourcesCited: citedSources?.count,
        memoriesCore: memoriesCore,
        memoriesRecalled: memoriesRecalled,
        memoryTextsCore: textsCore,
        memoryTextsRecalled: textsRecalled,
        beats: beats,
        evidence: evidence,
        developer: developer,
        current: status == .live ? currentOf(steps, stepStatus: stepStatus, callsOf: callsOf) : nil
    )
}

private func phasesOf(
    _ steps: [StepRecord],
    status: ActivityTurnStatus,
    totalMs: Int?,
    stepStatus: (StepRecord) -> ActivityStepStatus,
    stepDuration: (StepRecord) -> Int?,
    finalAnswer: StepRecord?
) -> [ActivityPhase] {
    var ms: [ActivityPhaseID: Int] = [:]
    var running: ActivityPhaseID?
    var sawTools = false
    var counted = 0

    for step in steps {
        let duration = stepDuration(step) ?? 0
        let live = stepStatus(step) == .running
        counted += duration
        switch step.kind {
        case "memory":
            ms[.memory, default: 0] += duration
            if live { running = .memory }
        case "tools":
            sawTools = true
            ms[.search, default: 0] += duration
            if live { running = .search }
        case "input":
            ms[.setup, default: 0] += duration
        default:
            let first = step.firstTokenMs
            if step === finalAnswer, let first, first <= duration {
                ms[.reason, default: 0] += first
                ms[.answer, default: 0] += duration - first
            } else if live, let first, first <= duration {
                ms[sawTools ? .reason : .plan, default: 0] += first
                ms[.answer, default: 0] += duration - first
                running = .answer
            } else if step === finalAnswer {
                ms[.answer, default: 0] += duration
            } else if step.end?.outcome == "tool_calls" || (live && !sawTools) {
                ms[sawTools ? .reason : .plan, default: 0] += duration
                if live { running = sawTools ? .reason : .plan }
            } else {
                ms[.reason, default: 0] += duration
                if live { running = .reason }
            }
        }
    }
    if let totalMs, totalMs > counted { ms[.setup, default: 0] += totalMs - counted }
    // Live with no step open: the agent is between steps or not started yet.
    if status == .live, running == nil { running = .setup }
    return ActivityPhaseID.allCases
        .filter { (ms[$0] ?? 0) > 0 || running == $0 }
        .map { ActivityPhase(id: $0, ms: ms[$0] ?? 0, running: running == $0) }
}

private func currentOf(
    _ steps: [StepRecord],
    stepStatus: (StepRecord) -> ActivityStepStatus,
    callsOf: (StepRecord) -> [ActivityCallView]
) -> ActivityCurrent? {
    guard let open = steps.last(where: { stepStatus($0) == .running }) else { return nil }
    switch open.kind {
    case "memory": return .memory
    case "input": return .input
    case "tools":
        let calls = callsOf(open)
        let next = calls.first { $0.status == .running } ?? calls.first
        if let next, searchTools.contains(next.name) { return .search(query: next.query) }
        return .tool(name: next?.name ?? open.name)
    default:
        return open.firstTokenMs != nil ? .writing : .thinking
    }
}
