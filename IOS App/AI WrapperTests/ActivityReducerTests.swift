import Testing
import Foundation
@testable import AI_Wrapper

/// The activity reducer against the shared golden logs (ActivityFixtures are copies of
/// retrieval-server/tests/fixtures/activity). The expected values match the component
/// library's activity.reduce.test.tsx, so both clients derive the same panel.
private final class FixtureBundle {}

private struct Fixture {
    let events: [ActivityEvent]
    let webSources: [Int]
    let live: Bool
    let stopReason: String?

    init(_ name: String) throws {
        let bundle = Bundle(for: FixtureBundle.self)
        let url = try #require(bundle.url(forResource: name, withExtension: "json")
            ?? bundle.url(forResource: name, withExtension: "json", subdirectory: "ActivityFixtures"))
        let json = try #require(JSONValue.parse(try Data(contentsOf: url)))
        events = json["events"]?.array?.compactMap(ActivityEvent.init(json:)) ?? []
        webSources = json["web_sources"]?.array?.compactMap { $0["index"]?.int } ?? []
        live = json["live"]?.boolean ?? false
        stopReason = json["stop_reason"]?.string
    }

    func reduce(nowMs: Int? = nil) -> ActivityView {
        reduceActivity(events, isLive: live, nowMs: nowMs, stopReason: stopReason, citedFallback: webSources)
    }
}

private func phaseMs(_ view: ActivityView) -> [String: Int] {
    Dictionary(uniqueKeysWithValues: view.phases.map { ($0.id.rawValue, $0.ms) })
}

struct ActivityCompletedTurnTests {
    @Test func totalsMatchTheDesignBoards() throws {
        let view = try Fixture("completed_six_searches").reduce()
        #expect(view.status == .done)
        #expect(view.totalMs == 22000)
        #expect(view.searchesUsed == 6)
        #expect(view.searchesMax == 6)
        #expect(view.sourcesFound == 31)
        #expect(view.sourcesCited == 6)
        #expect(view.memoriesCore == 14)
        #expect(view.memoriesRecalled == 2)
    }

    @Test func timeSplitsIntoFivePhases() throws {
        let view = try Fixture("completed_six_searches").reduce()
        #expect(phaseMs(view) == ["memory": 400, "plan": 3100, "search": 10000, "reason": 6500, "answer": 2000])
        #expect(view.phases.map(\.id) == [.memory, .plan, .search, .reason, .answer])
        #expect(!view.phases.contains { $0.running })
    }

    @Test func storyHasSevenBeats() throws {
        let view = try Fixture("completed_six_searches").reduce()
        #expect(view.beats.map(\.typeName) == ["memory", "plan", "tools", "plan", "tools", "read", "answer"])
        #expect(view.beats.map(\.durationMs) == [400, 3100, 4800, 2900, 5200, 3600, 2000])
        guard case .plan(_, let reasoning, _, _) = view.beats[1].kind else { Issue.record("expected plan"); return }
        #expect(reasoning?.hasPrefix("Those three wedges were inferences") == true)
    }

    @Test func callsCarryPurposeCountAndTime() throws {
        let view = try Fixture("completed_six_searches").reduce()
        guard case .tools(let family, let calls, let found, let cited, _, _, _) = view.beats[2].kind else {
            Issue.record("expected tools"); return
        }
        #expect(family == .search)
        #expect(calls.map(\.seq) == [1, 2, 3])
        #expect(calls.map(\.status) == [.done, .done, .done])
        #expect(calls.map(\.resultCount) == [9, 8, 8])
        #expect(calls.map(\.durationMs) == [4600, 3900, 4200])
        #expect(calls[0].purpose == "Find measured technology adoption by industry for small firms.")
        #expect(calls[0].query == "US small business technology adoption by industry, Census ABS 2024-2025")
        #expect(found == 25)
        #expect(cited == 4)
        guard case .tools(_, let secondRound, _, _, _, _, _) = view.beats[4].kind else { Issue.record("expected tools"); return }
        #expect(secondRound[2].resultCount == 0)
    }

    @Test func sourcesKeepSiteIconAndDateAndCitation() throws {
        let view = try Fixture("completed_six_searches").reduce()
        let first = view.evidence[0].sources[0]
        #expect(first.source.index == 1)
        #expect(first.domain == "cms.gov")
        #expect(first.cited == true)
        #expect(first.source.favicon == "https://www.cms.gov/favicon.ico")
        #expect(first.source.publishedDate == "2023-06-01")
        #expect(view.evidence[0].sources[1].cited == false)
        #expect(view.evidence.map(\.found) == [25, 6])
        #expect(view.evidence.map(\.cited) == [4, 2])
    }

    @Test func answerListsTheSourcesItCites() throws {
        let view = try Fixture("completed_six_searches").reduce()
        guard case .answer(_, let cited) = view.beats[6].kind else { Issue.record("expected answer"); return }
        #expect(cited.map(\.source.index) == [1, 3, 12, 21, 26, 27])
    }

    @Test func authorDataIsKeptForTheAuthor() throws {
        let view = try Fixture("completed_six_searches").reduce()
        #expect(view.memoryTextsRecalled?.count == 2)
        #expect(view.memoryTextsCore?.count == 14)
        #expect(view.developer.count == 3)
    }
}

/// activity.reduce.test.tsx "when the answer starts": the panel folds on this.
struct ActivityAnswerStartTests {
    /// The completed turn's log up to and including the first matching event.
    private func upTo(_ type: ActivityEventType, _ id: String) throws -> [ActivityEvent] {
        let events = try Fixture("completed_six_searches").events
        let index = try #require(events.firstIndex { $0.type == type && $0.id == id })
        return Array(events.prefix(through: index))
    }

    private func answering(_ events: [ActivityEvent]) -> Bool {
        reduceActivity(events, isLive: true).answering
    }

    @Test func takesTheStepForTheAnswerOnceItWritesMoreThanAPreamble() throws {
        #expect(!answering(try upTo(.stepProgress, "NODAGENT001:3")))
        #expect(answering(try upTo(.stepWriting, "NODAGENT001:3")))
    }

    @Test func neverTakesAPreambleFollowedByAToolCallForTheAnswer() throws {
        #expect(!answering(try upTo(.stepProgress, "NODAGENT001:1")))
        #expect(!answering(try upTo(.stepCalling, "NODAGENT001:1")))
        let json = try #require(JSONValue.parse(Data(#"{"v":2,"at":21500,"type":"step.calling","id":"NODAGENT001:3"}"#.utf8)))
        let calling = try #require(ActivityEvent(json: json))
        #expect(!answering(try upTo(.stepWriting, "NODAGENT001:3") + [calling]))
    }

    @Test func isTheAnswerOnceTheAnswerStepEnds() throws {
        #expect(answering(try upTo(.stepEnd, "NODAGENT001:3")))
    }

    @Test func isThinkingWhileALaterStepRunsAndNeverOnceTheLogSaysTheTurnIsOver() throws {
        #expect(!(try Fixture("live_mid_turn").reduce(nowMs: 14300).answering))
        let ended = reduceActivity(try Fixture("completed_six_searches").events, isLive: true)
        #expect(ended.status == .done)
        #expect(!ended.answering)
    }
}

struct ActivityLiveTurnTests {
    @Test func clockRunsOnTheServerTimeline() throws {
        let view = try Fixture("live_mid_turn").reduce(nowMs: 14300)
        #expect(view.status == .live)
        #expect(view.totalMs == 14300)
        #expect(phaseMs(view) == ["memory": 400, "plan": 3100, "search": 7900, "reason": 2900])
        #expect(view.phases.first { $0.running }?.id == .search)
    }

    @Test func runningRoundTicksOffOneQuery() throws {
        let view = try Fixture("live_mid_turn").reduce(nowMs: 14300)
        guard case .tools(_, let calls, _, _, _, _, _) = view.beats.last!.kind else { Issue.record("expected tools"); return }
        #expect(view.beats.last?.status == .running)
        #expect(calls.map(\.status) == [.done, .running, .running])
        #expect(calls.map(\.resultCount) == [4, nil, nil])
        #expect(calls[1].purpose == "Measure how much eligible CCM billing goes unused.")
        #expect(view.current == .search(query: "unused CCM billing eligible practices percent"))
    }

    @Test func citationsWaitForTheAnswer() throws {
        let fixture = try Fixture("live_mid_turn")
        let view = fixture.reduce(nowMs: 14300)
        #expect(view.searchesUsed == 6)
        #expect(view.searchesMax == 6)
        #expect(view.sourcesFound == 25)
        #expect(view.sourcesCited == nil)
        let withFallback = reduceActivity(fixture.events, isLive: true, nowMs: 14300, citedFallback: [1, 2, 3])
        #expect(withFallback.sourcesCited == nil)
    }
}

struct ActivityEdgeCaseTests {
    @Test func budgetModesCountOnlyDispatchedSearches() throws {
        let view = try Fixture("denied_searches").reduce()
        #expect(view.searchesUsed == 5)
        #expect(view.searchesMax == 5)
        #expect(view.sourcesFound == 6)
        #expect(view.sourcesCited == 2)
        #expect(view.evidence.map { $0.calls.map(\.status) } == [
            [.done, .done, .done, .skipped],
            [.done, .skipped, .skipped],
            [.done, .denied],
        ])
        #expect(view.evidence.reduce(0) { $0 + $1.failedCalls.count } == 4)
        let rounds = view.beats.compactMap { beat -> Int? in
            if case .plan(let round, _, _, _) = beat.kind { return round }
            return nil
        }
        #expect(rounds == [1, 2, 3])
    }

    @Test func anErroredTurnFailsItsOpenStep() throws {
        let view = try Fixture("error_turn").reduce()
        #expect(view.status == .failed)
        #expect(view.totalMs == 4200)
        #expect(view.beats.last?.typeName == "thinking")
        #expect(view.beats.last?.status == .failed)
        #expect(view.beats.last?.durationMs == 700)
        guard case .tools(_, let calls, _, _, _, _, _) = view.beats[2].kind else { Issue.record("expected tools"); return }
        #expect(calls[1].status == .failed)
        #expect(calls[1].error == "TimeoutError: search provider did not answer within 30s")
        #expect(view.sourcesCited == nil)
    }

    @Test func aSubagentIsItsOwnFamily() throws {
        let view = try Fixture("subagent_call").reduce()
        #expect(view.beats.map(\.typeName) == ["memory", "plan", "tools", "read", "answer"])
        guard case .tools(let family, let calls, _, _, _, _, _) = view.beats[2].kind else { Issue.record("expected tools"); return }
        #expect(family == .subagent)
        #expect(calls[0].hasDetails)
        #expect(calls[0].resultCount == 2)
        #expect(calls[0].query?.hasPrefix("Compare ChartSpan and ThoroughCare") == true)
        #expect(view.sourcesFound == 2)
        #expect(view.sourcesCited == 2)
    }

    @Test func aPlainAnswerHasTwoBeats() throws {
        let view = try Fixture("memory_only").reduce()
        #expect(view.beats.map(\.typeName) == ["memory", "answer"])
        #expect(view.beats[1].durationMs == 1900)
        #expect(phaseMs(view) == ["memory": 200, "reason": 600, "answer": 1300])
    }

    @Test func aStoppedTurnKeepsTheCallsThatFinished() throws {
        let view = try Fixture("stopped_turn").reduce()
        #expect(view.status == .stopped)
        #expect(view.totalMs == 7900)
        guard case .tools(_, let calls, _, _, _, _, _) = view.beats.last!.kind else { Issue.record("expected tools"); return }
        #expect(view.beats.last?.status == .stopped)
        #expect(calls.map(\.status) == [.stopped, .done, .done])
        #expect(view.current == nil)
    }

    @Test func setupFillsTheWaitBeforeTheFirstStep() {
        let start = ActivityEvent(json: JSONValue.parse(#"{"v":2,"at":0,"type":"turn.start"}"#)!)!
        let view = reduceActivity([start], isLive: true, nowMs: 2400)
        #expect(view.phases == [ActivityPhase(id: .setup, ms: 2400, running: true)])
    }

    @Test func convertedHistoryWithNothingToReportHasNoReceipt() {
        let events = [
            #"{"v":2,"at":null,"type":"turn.start"}"#,
            #"{"v":2,"at":null,"type":"step.start","id":"a:1","kind":"llm","node":"a","name":"Agent"}"#,
            #"{"v":2,"at":null,"type":"step.end","id":"a:1","kind":"llm","node":"a","name":"Agent","outcome":"answer"}"#,
            #"{"v":2,"at":null,"type":"turn.end","outcome":"completed"}"#,
        ].compactMap { JSONValue.parse($0).flatMap(ActivityEvent.init(json:)) }
        #expect(events.count == 4)
        #expect(reduceActivity(events, isLive: false).hasReceipt == false)
        for name in ["completed_six_searches", "live_mid_turn", "memory_only", "stopped_turn"] {
            #expect((try? Fixture(name).reduce().hasReceipt) == true)
        }
    }

    @Test func otherVersionsAndTypesAreNotEvents() {
        #expect(ActivityEvent(json: JSONValue.parse(#"{"v":1,"type":"turn.start"}"#)!) == nil)
        #expect(ActivityEvent(json: JSONValue.parse(#"{"v":2,"at":1,"type":"step.future"}"#)!) == nil)
    }

    @Test func durationsAndDatesFormatLikeTheWeb() {
        #expect(ActivityFormat.duration(400) == "0.4s")
        #expect(ActivityFormat.duration(4800) == "4.8s")
        #expect(ActivityFormat.duration(22000) == "22s")
        #expect(ActivityFormat.duration(65000) == "1m 05s")
        #expect(ActivityFormat.sourceDate("Sun, 25 Oct 2026 00:00:00 GMT") != nil)
        #expect(ActivityFormat.sourceDate("2023-06-01") != nil)
        #expect(ActivityFormat.sourceDate("not a date") == nil)
        #expect(ActivityFormat.usableFavicon("http://a.test/favicon.ico") == nil)
        #expect(ActivityFormat.monogram("cms.gov") == "C")
    }
}
