import Testing
import Foundation
import SwiftUI
import UIKit
@testable import AI_Wrapper

// MARK: - NDJSON frames

@MainActor
struct StreamFrameTests {
    /// Runs lines through the parser and returns what each callback received.
    private final class Recorder {
        var deltas: [String] = []
        var resets = 0
        var stopReasons: [String] = []
        var activity: [ActivityEvent] = []
        var sources: [[WebSource]] = []
        var attachments: [[AttachmentRef]] = []
        var awaiting: [AwaitingInput] = []

        var callbacks: StreamCallbacks {
            StreamCallbacks(
                onDelta: { self.deltas.append($0) },
                onContentReset: { self.resets += 1 },
                onStopReason: { self.stopReasons.append($0) },
                onActivity: { self.activity.append($0) },
                onWebSources: { self.sources.append($0) },
                onGeneratedAttachments: { self.attachments.append($0) },
                onAwaitingInput: { self.awaiting.append($0) }
            )
        }
    }

    private func feed(_ line: String, into recorder: Recorder) throws -> Bool {
        try GenerateTextStreamService.processLine(line, recorder.callbacks)
    }

    @Test func contentFramesAppendText() throws {
        let recorder = Recorder()
        #expect(try feed(#"{"t":"c","v":"Hel"}"#, into: recorder) == false)
        #expect(try feed(#"{"t":"c","v":"lo"}"#, into: recorder) == false)
        #expect(recorder.deltas == ["Hel", "lo"])
    }

    @Test func contentResetClearsThePreamble() throws {
        let recorder = Recorder()
        _ = try feed(#"{"t":"cr"}"#, into: recorder)
        #expect(recorder.resets == 1)
    }

    @Test func stopReasonIgnoresEmptyValues() throws {
        let recorder = Recorder()
        _ = try feed(#"{"t":"sr","v":"end_turn"}"#, into: recorder)
        _ = try feed(#"{"t":"sr","v":""}"#, into: recorder)
        #expect(recorder.stopReasons == ["end_turn"])
    }

    @Test func cancelledDoneFrameEndsTheStreamAsStopped() throws {
        let recorder = Recorder()
        #expect(try feed(#"{"t":"done","status":"cancelled"}"#, into: recorder) == true)
        #expect(recorder.stopReasons == [StopReasonNote.cancelled])
    }

    @Test func activityEventsArriveAndRetiredThinkingFramesAreIgnored() throws {
        let recorder = Recorder()
        _ = try feed(#"{"t":"ac","v":{"v":2,"at":0,"type":"turn.start"}}"#, into: recorder)
        _ = try feed(#"{"t":"ac","v":{"v":2,"at":120,"type":"step.start","id":"N1:1","kind":"memory","node":"N1","name":"Memory"}}"#, into: recorder)
        _ = try feed(#"{"t":"ac","v":{"v":1,"type":"turn.start"}}"#, into: recorder)
        _ = try feed(#"{"t":"ks","v":{"node":"N1","name":"Memory","status":"running","kind":"MEMORY"}}"#, into: recorder)
        _ = try feed(#"{"t":"kd","v":1500}"#, into: recorder)
        #expect(recorder.activity.map(\.type) == [.turnStart, .stepStart])
        #expect(recorder.activity.last?.id == "N1:1")
        #expect(recorder.activity.last?.at == 120)
        #expect(recorder.deltas.isEmpty)
    }

    @Test func webSourcesDecodeAndEmptyListsAreDropped() throws {
        let recorder = Recorder()
        _ = try feed(#"{"t":"ws","v":[{"index":2,"title":"A","url":"https://a.test"}]}"#, into: recorder)
        _ = try feed(#"{"t":"ws","v":[]}"#, into: recorder)
        #expect(recorder.sources.count == 1)
        #expect(recorder.sources.first?.first?.index == 2)
    }

    @Test func generatedAttachmentsNormalizeSnakeCaseAndDropIdlessEntries() throws {
        let recorder = Recorder()
        _ = try feed(#"{"t":"ga","v":[{"artifact_id":"a1","key":"k","media_type":"application/pdf","filename":"f.pdf","size_bytes":12},{"filename":"no-id"}]}"#, into: recorder)
        let refs = try #require(recorder.attachments.first)
        #expect(refs.count == 1)
        #expect(refs.first?.attachmentId == "a1")
        #expect(refs.first?.mediaType == "application/pdf")
    }

    @Test func awaitingInputReadsEitherRunIdSpelling() throws {
        let recorder = Recorder()
        _ = try feed(#"{"t":"ai","v":{"prompt":"Which one?","run_id":"r1"}}"#, into: recorder)
        _ = try feed(#"{"t":"ai","v":{"runId":"r2"}}"#, into: recorder)
        #expect(recorder.awaiting.map(\.runId) == ["r1", "r2"])
        #expect(recorder.awaiting.first?.prompt == "Which one?")
    }

    @Test func doneIsTerminal() throws {
        #expect(try feed(#"{"t":"done"}"#, into: Recorder()) == true)
        #expect(try feed(#"{"t":"done","status":"ok"}"#, into: Recorder()) == true)
    }

    @Test func errorFramesThrowTheServerMessage() {
        #expect(throws: StreamGenerationError.self) { try feed(#"{"t":"err","v":"boom"}"#, into: Recorder()) }
        #expect(throws: StreamGenerationError.self) { try feed(#"{"t":"done","status":"error","m":"boom"}"#, into: Recorder()) }
        #expect(throws: StreamGenerationError.self) { try feed("[Error: quota]", into: Recorder()) }
    }

    @Test func heartbeatsAndBlanksAreIgnored() throws {
        let recorder = Recorder()
        #expect(try feed(#"{"t":"hb"}"#, into: recorder) == false)
        #expect(try feed("   ", into: recorder) == false)
        #expect(recorder.deltas.isEmpty)
    }

    @Test func nonJSONLinesFallBackToLegacyRawText() throws {
        let recorder = Recorder()
        _ = try feed("plain words", into: recorder)
        #expect(recorder.deltas == ["plain words"])
    }
}

// MARK: - Citations and quotes

struct CitationLinkTests {
    private let sources = [WebSource(index: 2, title: "Two", url: "https://two.test"), WebSource(index: 21, title: "T", url: "https://21.test")]
    private let many = (1...6).map { WebSource(index: $0, title: "S\($0)", url: "https://s\($0).test") }

    @Test func markersLinkByTheirOriginalIndex() {
        #expect(CitationText.linkify("See [2][21].", sources: sources) == "See [[2]](cite://2)[[21]](cite://21).")
    }

    @Test func strayMarkersStayPlain() {
        #expect(CitationText.linkify("See [9].", sources: sources) == "See [9].")
        #expect(CitationText.linkify("See [2][9].", sources: sources) == "See [[2]](cite://2)[9].")
    }

    @Test func existingLinksAreLeftAlone() {
        #expect(CitationText.linkify("[2](https://x.test)", sources: sources) == "[2](https://x.test)")
    }

    @Test func aTrainingSourceIsAChipLikeAnyOther() throws {
        let training = WebSource(index: 4, title: "Kahneman, 2011", url: "", origin: "training")
        #expect(CitationText.linkify("Known [4].", sources: [training]) == "Known [[4]](cite://4).")
        let json = try #require(JSONValue.parse(Data(#"{"index":4,"title":"K","url":"","origin":"training"}"#.utf8)))
        let parsed = try #require(WebSource(json: json))
        #expect(parsed.isTraining)
        #expect(!sources[0].isTraining)
    }

    /// UA-18 / UA-19: the Sources list keeps a training reference whole, in a view that can be
    /// selected and copied, with the muted note running on after it.
    @MainActor @Test func aTrainingReferenceIsShownWholeAndSelectable() throws {
        let reference = "Kendall et al., Muscles: Testing and Function with Posture and Pain, 5th ed., 2005"
        let view = SourcesSection.trainingReference(WebSource(index: 4, title: reference, url: "", origin: "training"))
        let text = view.attributed
        #expect(text.string == reference.webHyphenBreakable + " (from training knowledge)")
        let primary = text.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor
        let note = text.attribute(.foregroundColor, at: text.length - 1, effectiveRange: nil) as? UIColor
        #expect(primary == AppTheme.UI.textPrimary)
        #expect(note == AppTheme.UI.textMuted)

        // Narrow enough to need more than one 20.4 pt line: nothing is cut, the row grows.
        #expect(MarkdownTextView.height(of: text, width: 240) > 21)
    }

    @Test func noSourcesMeansNoWork() {
        #expect(CitationText.linkify("See [2].", sources: nil) == "See [2].")
    }

    @Test func aLongRunFoldsIntoPlusN() {
        #expect(CitationText.linkify("Claim [1][2][3][4][5][6].", sources: many)
            == "Claim [[1]](cite://1)[[2]](cite://2)[[3]](cite://3)[[4][5][6]](cite://more/4,5,6).")
        #expect(CitationText.linkify("Claim [1][2][3][4].", sources: many)
            == "Claim [[1]](cite://1)[[2]](cite://2)[[3]](cite://3)[[4]](cite://4).")
    }

    @Test func escapedMarkersLinkAsPlainOnes() {
        #expect(CitationText.linkify(#"Growth: **300 req/min** \[2\] and \[9\]."#, sources: sources)
            == #"Growth: **300 req/min** [[2]](cite://2) and \[9\]."#)
        #expect(CitationText.counts(#"a \[2\] b [2]"#) == [2: 2])
    }

    @Test func countsEachMarker() {
        #expect(CitationText.counts("a [2] b [2][21] [x](y)") == [2: 2, 21: 1])
    }

    @Test func readsTheSourcesOfALink() {
        #expect(CitationText.indexes(of: URL(string: "cite://16")!) == [16])
        #expect(CitationText.indexes(of: URL(string: "cite://more/4,5,6")!) == [4, 5, 6])
        #expect(CitationText.indexes(of: URL(string: "https://two.test")!) == nil)
    }
}

@MainActor
struct CitationChipTests {
    @Test func aChipCopiesAsItsMarker() throws {
        let parsed = MarkdownParser.segments(for: CitationText.linkify("Shares [16].", sources: [WebSource(index: 16, title: "F", url: "https://f.test")]), options: .init(turnTextSize: 16, reader: true))
        guard case .text(_, let text, _, _) = try #require(parsed.first) else { Issue.record("not text"); return }
        #expect(text.string.contains("16"))
        #expect(!text.string.contains("[16]"))
        #expect(CitationChipBox.plainText(of: text, in: NSRange(location: 0, length: text.length)) == "Shares[16].")
        var chips = 0
        text.enumerateAttribute(.mdCitation, in: NSRange(location: 0, length: text.length)) { value, _, _ in
            if value is CitationChipBox { chips += 1 }
        }
        #expect(chips == 1)
    }

    @Test func anEscapedMarkerIsNotAFormula() throws {
        // Real prod answer: a model escaped its citations, which read as display math
        let parsed = MarkdownParser.segments(for: #"- Growth: **300 req/min** \[6\]"# + "\n\nNext", options: .init(turnTextSize: 16, reader: true))
        #expect(!parsed.contains { if case .math = $0 { return true }; return false })
        guard case .text(_, let text, _, _) = try #require(parsed.first) else { Issue.record("not text"); return }
        #expect(text.string.contains("[6]"))
        let formula = MarkdownParser.segments(for: #"\[ 2 + 2 \]"#, options: .init(turnTextSize: 16, reader: true))
        #expect(formula.contains { if case .math = $0 { return true }; return false })
    }

    @Test func theReadingSettingUsesTheSerif() throws {
        let parsed = MarkdownParser.segments(for: "Text", options: .init(turnTextSize: 16, reader: true))
        guard case .text(_, let text, _, _) = try #require(parsed.first) else { Issue.record("not text"); return }
        let font = try #require(text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        #expect(font.familyName == "Source Serif 4")
        #expect(abs(font.pointSize - DSFont.scaledSize(17)) < 0.01)
    }
}

@MainActor
struct AskQuoteTests {
    @Test func everyLineIsQuotedAndBlankLinesStayBare() {
        #expect(ConversationStore.markdownQuote("foo\n\nbar") == "> foo\n>\n> bar")
    }

    @Test func surroundingWhitespaceIsTrimmed() {
        #expect(ConversationStore.markdownQuote("  foo \n") == "> foo")
    }
}

// MARK: - Markdown

struct MarkdownSegmentTests {
    private func kinds(_ markdown: String) -> [String] {
        MarkdownParser.segments(for: markdown).map { segment in
            switch segment {
            case .text: return "text"
            case .code: return "code"
            case .table: return "table"
            case .math: return "math"
            case .image: return "image"
            }
        }
    }

    @Test func blocksSplitIntoTheirOwnViews() {
        #expect(kinds("Hello\n\n```swift\nlet x = 1\n```\n\nBye") == ["text", "code", "text"])
    }

    @Test func tablesAreTheirOwnBlock() {
        #expect(kinds("| A | B |\n|---|---|\n| 1 | 2 |") == ["table"])
    }

    @Test func displayMathIsItsOwnBlock() {
        #expect(kinds("$$\nE=mc^2\n$$") == ["math"])
    }

    @Test func singleDollarIsCurrencyNotMath() {
        #expect(kinds("It costs $5 and $6.") == ["text"])
    }

    @Test func softBreaksInsideAParagraphCollapse() throws {
        let segment = try #require(MarkdownParser.segments(for: "1\n2\n3").first)
        guard case .text(_, let text, _, _) = segment else {
            Issue.record("expected text")
            return
        }
        #expect(!text.string.contains("\n"))
    }

    @Test func aTextSegmentAfterCodeCarriesTheCollapsedMargin() throws {
        let segments = MarkdownParser.segments(for: "```\nx\n```\n\n### Pros")
        guard case .text(_, _, let top, _) = try #require(segments.last) else {
            Issue.record("expected text")
            return
        }
        #expect(top == 24)
    }

    @Test func theMarginBeforeABlockCollapsesOntoTheBlockAlone() throws {
        let segments = MarkdownParser.segments(for: "Hello\n\n```\nx\n```")
        guard case .text(_, _, _, let textBottom) = try #require(segments.first),
              case .code(_, _, _, let codeTop, let codeBottom) = try #require(segments.last) else {
            Issue.record("expected text then code")
            return
        }
        #expect(textBottom == 0)
        #expect(codeTop == 16)
        #expect(codeBottom == 24)
    }

    @Test func codeKeepsItsLanguageAndDropsTheTrailingNewline() throws {
        guard case .code(_, let language, let code, _, _) = try #require(MarkdownParser.segments(for: "```py\nprint(1)\n```").first) else {
            Issue.record("expected code")
            return
        }
        #expect(language == "py")
        #expect(code == "print(1)")
    }

    @Test func tightAndLooseListsAreToldApart() {
        #expect(MarkdownParser.listLooseness(in: "- a\n- b") == [false])
        #expect(MarkdownParser.listLooseness(in: "- a\n\n- b") == [true])
    }

    @Test func fencedCodeIsNotMistakenForAList() {
        #expect(MarkdownParser.listLooseness(in: "```\n- a\n\n- b\n```").isEmpty)
    }
}

// MARK: - Ordered JSON (agent configs round-trip untouched)

struct OrderedJSONTests {
    @Test func keyOrderSurvivesParsingAndPrinting() throws {
        let value = try #require(JSONValue.parse(#"{"z":1,"a":{"y":2,"b":3}}"#))
        #expect(value.pairs?.map(\.0) == ["z", "a"])
        #expect(value["a"]?.pairs?.map(\.0) == ["y", "b"])
        #expect(value.jsonString == #"{"z":1,"a":{"y":2,"b":3}}"#)
    }

    @Test func prettyPrintKeepsOrderAndIndents() {
        #expect(AgentConfigJSON.pretty(#"{"b":1,"a":[true,null]}"#) == "{\n  \"b\": 1,\n  \"a\": [\n    true,\n    null\n  ]\n}")
    }

    @Test func invalidJSONIsReturnedAsTyped() {
        #expect(JSONValue.parse("{nope") == nil)
        #expect(AgentConfigJSON.pretty("{nope") == "{nope")
        #expect(AgentConfigJSON.isValid("{nope") == false)
        #expect(AgentConfigJSON.isValid(#"{"a":1}"#))
    }

    @Test func numbersKeepTheirExactText() throws {
        let value = try #require(JSONValue.parse(#"{"n":1.50}"#))
        #expect(value["n"]?.jsonString == "1.50")
    }
}

// MARK: - Formatting and rules

struct UsageFormatTests {
    @Test func usdKeepsUpToFourDecimalsUnderADollar() {
        #expect(SettingsFormat.usd(0.0421) == "$0.0421")
        #expect(SettingsFormat.usd(0.21) == "$0.21")
        #expect(SettingsFormat.usd(1.5) == "$1.50")
        #expect(SettingsFormat.usd(0) == "$0.00")
    }

    @Test func countsUseGroupingAndMillionsShorten() {
        #expect(SettingsFormat.count(1234567) == "1,234,567")
        #expect(SettingsFormat.compactCount(486_400) == "486,400")
        #expect(SettingsFormat.compactCount(1_700_000) == "1.7M")
        #expect(SettingsFormat.compactCount(17_149_000) == "17.1M")
        #expect(SettingsFormat.compactCount(2_000_000) == "2M")
        #expect(SettingsFormat.compactCount(1_999_960_000) == "2B")
    }

    @Test func chartLabelsKeepTinyCostsReadable() {
        #expect(SettingsFormat.chartUsd(0) == "$0")
        #expect(SettingsFormat.chartUsd(0.000052) == "$0.000052")
        #expect(SettingsFormat.chartUsd(0.4378) == "$0.4378")
        #expect(SettingsFormat.chartUsd(12.5) == "$12.50")
    }

    @Test func longRangesBecomeWeeks() {
        let days = [(date: "2026-11-01", value: 1.0, count: 2), (date: "2026-11-03", value: 0.5, count: 1)]
        let month = DailySeries.bucket(days, from: "2026-11-01", to: "2026-11-30")
        #expect(!month.isWeekly)
        #expect(month.buckets.count == 30)
        #expect(month.buckets[2].value == 0.5)
        let quarter = DailySeries.bucket(days, from: "2026-08-20", to: "2026-11-17")
        #expect(quarter.isWeekly)
        #expect(quarter.buckets.count == 13)
        #expect(quarter.buckets.reduce(0) { $0 + $1.count } == 3)
    }

    @Test func gridlinesRoundUpToANiceTop() {
        #expect(UsageBarChart.niceMax(0) == 1)
        #expect(UsageBarChart.niceMax(0.4378) == 0.5)
        #expect(UsageBarChart.niceMax(7) == 10)
    }

    @Test func embeddingModelChoiceFollowsTheServerRules() {
        var prefs = AIConfigPreferences()
        #expect(EmbeddingModelChoice.chosen(prefs) == nil)
        prefs.embeddingModelConversations = " "
        prefs.embeddingModel = "voyage-4-large"
        #expect(EmbeddingModelChoice.chosen(prefs) == "voyage-4-large")
        let listed = [EmbeddingVendorModels(vendor: EmbeddingVendor.openAI, models: ["text-embedding-3-large"])]
        #expect(!EmbeddingModelChoice.isUnusable("text-embedding-3-large", vendorModels: listed))
        #expect(EmbeddingModelChoice.isUnusable("text-embedding-ada-002", vendorModels: listed))
        #expect(!EmbeddingModelChoice.isUnusable("voyage-multimodal-3.5", vendorModels: listed))
        #expect(EmbeddingModelChoice.isUnusable("mystery", vendorModels: listed))
    }

    @Test func trailingWindowIsInclusive() throws {
        let zone = try #require(TimeZone(identifier: "UTC"))
        let range = UsageDateRange.trailing(days: 7, timeZone: zone)
        let from = try #require(UsageDateRange.date(range.from, timeZone: zone))
        let to = try #require(UsageDateRange.date(range.to, timeZone: zone))
        #expect(to.timeIntervalSince(from) == 6 * 86_400)
    }

    @Test func responseCostMatchesTheWebFormat() {
        #expect(ResponseCardView.formatUsd(1.234) == "$1.23")
        #expect(ResponseCardView.formatUsd(0.0002) == "$0.0002")
    }
}

struct ToolRuleTests {
    @Test func toolNamesFollowTheBackendPattern() {
        #expect(ToolRules.isValidName("create_issue"))
        #expect(!ToolRules.isValidName("ab"))
        #expect(!ToolRules.isValidName("1abc"))
        #expect(!ToolRules.isValidName("Create"))
    }

    @Test func argumentNamesAllowUppercaseButNotDigitsFirst() {
        #expect(ToolRules.isValidArgumentName("userId"))
        #expect(ToolRules.isValidArgumentName("_x"))
        #expect(!ToolRules.isValidArgumentName("1x"))
        #expect(!ToolRules.isValidArgumentName("a-b"))
    }
}

struct TokenEstimateTests {
    @Test func cjkCountsPerCharacterAndTheRestPerFour() {
        #expect(TokenEstimator.estimateTokens("") == 0)
        #expect(TokenEstimator.estimateTokens("abcd") == 1)
        #expect(TokenEstimator.estimateTokens("abcde") == 2)
        #expect(TokenEstimator.estimateTokens("日本語") == 3)
    }
}

/// The same cases as the web's `usageDateRange.test.ts`.
struct UsageDateRangeZoneTests {
    private func moment(_ iso: String) throws -> Date {
        try #require(ISO8601DateFormatter().date(from: iso))
    }

    private func zone(_ id: String) throws -> TimeZone {
        try #require(TimeZone(identifier: id))
    }

    @Test(arguments: [
        ("America/Los_Angeles", "2026-11-05T00:01:00Z", "2026-10-06", "2026-11-04"),
        ("America/Los_Angeles", "2026-03-20T00:30:00Z", "2026-02-18", "2026-03-19"),
        ("UTC", "2026-11-05T00:01:00Z", "2026-10-07", "2026-11-05"),
        ("Asia/Kolkata", "2026-11-04T18:29:00Z", "2026-10-06", "2026-11-04"),
        ("Asia/Kolkata", "2026-11-04T18:31:00Z", "2026-10-07", "2026-11-05"),
        ("Australia/Sydney", "2026-11-04T13:30:00Z", "2026-10-07", "2026-11-05")
    ])
    func showsLocalDays(zoneId: String, now: String, from: String, to: String) throws {
        let range = UsageDateRange.trailing(days: 30, now: try moment(now), timeZone: try zone(zoneId))
        #expect(range == UsageDateRange(from: from, to: to))
    }

    @Test(arguments: [
        ("America/Los_Angeles", "2026-11-04", "2026-11-04", "2026-11-04", "2026-11-05"),
        ("America/Los_Angeles", "2026-10-06", "2026-11-04", "2026-10-06", "2026-11-05"),
        ("UTC", "2026-11-04", "2026-11-04", "2026-11-04", "2026-11-04"),
        ("Asia/Kolkata", "2026-11-04", "2026-11-04", "2026-11-03", "2026-11-04"),
        ("Australia/Sydney", "2026-11-04", "2026-11-04", "2026-11-03", "2026-11-04")
    ])
    func asksForEveryUTCDayItTouches(zoneId: String, from: String, to: String, utcFrom: String, utcTo: String) throws {
        let utc = UsageDateRange(from: from, to: to).utcDays(timeZone: try zone(zoneId))
        #expect(utc == UsageDateRange(from: utcFrom, to: utcTo))
    }

    @Test func staysThirtyDaysAtEveryHourAcrossAClockChange() throws {
        let losAngeles = try zone("America/Los_Angeles")
        let utc = try zone("UTC")
        for hour in 0..<24 {
            let now = try moment(String(format: "2026-11-04T%02d:00:00Z", hour))
            let range = UsageDateRange.trailing(days: 30, now: now, timeZone: losAngeles)
            let from = try #require(UsageDateRange.date(range.from, timeZone: utc))
            let to = try #require(UsageDateRange.date(range.to, timeZone: utc))
            #expect(to.timeIntervalSince(from) == 29 * 86_400)
        }
    }
}

/// The same cases as the library's `tooltipPlacement.test.tsx`.
struct TooltipLayoutTests {
    private let phone = CGSize(width: 402, height: 874)
    private let tooltip = CGSize(width: 300, height: 48)

    private func box(_ left: CGFloat, _ top: CGFloat, _ width: CGFloat = 40, _ height: CGFloat = 20) -> CGRect {
        CGRect(x: left, y: top, width: width, height: height)
    }

    @Test func goesRightOfTheAnchorWhenItFits() {
        let layout = TooltipLayout.place(anchor: box(24, 400), tooltip: tooltip, viewport: phone)
        #expect(layout.placement == .right)
        #expect(layout.left == 72)
    }

    @Test func flipsLeftWhenOnlyTheLeftSideFits() {
        let layout = TooltipLayout.place(anchor: box(900, 400), tooltip: tooltip, viewport: CGSize(width: 1000, height: 800))
        #expect(layout.placement == .left)
        #expect(layout.left == 592)
    }

    @Test(arguments: [CGFloat(80), 127, 162, 218])
    func staysOnAPhoneScreenWhenNeitherSideFits(anchorLeft: CGFloat) {
        let layout = TooltipLayout.place(anchor: box(anchorLeft, 780), tooltip: tooltip, viewport: phone)
        #expect(layout.placement == .top)
        #expect(layout.left - tooltip.width / 2 >= 8)
        #expect(layout.left + tooltip.width / 2 <= phone.width - 8)
        #expect(layout.top >= 8)
        #expect(layout.top + tooltip.height <= 780)
    }

    @Test func goesBelowWhenThereIsNoRoomAboveEither() {
        let layout = TooltipLayout.place(anchor: box(120, 20), tooltip: tooltip, viewport: phone)
        #expect(layout.placement == .bottom)
        #expect(layout.top == 48)
    }

    @Test func keepsTheArrowOnTheAnchorAfterShiftingTheTooltip() {
        let layout = TooltipLayout.place(anchor: box(300, 780), tooltip: tooltip, viewport: phone)
        #expect(layout.placement == .top)
        #expect(layout.left - tooltip.width / 2 + (layout.arrowLeft ?? 0) == 320)
    }

    @Test func keepsTheArrowOnTheTooltipForAnAnchorAtTheVeryEdge() {
        let layout = TooltipLayout.place(anchor: box(0, 780, 4), tooltip: CGSize(width: 390, height: 48), viewport: phone)
        #expect(layout.placement == .top)
        #expect(layout.arrowLeft == 8)
    }

    @Test func keepsASideTooltipInsideTheTopAndBottomOfTheScreen() {
        #expect(TooltipLayout.place(anchor: box(24, 0), tooltip: tooltip, viewport: phone).top == 32)
        #expect(TooltipLayout.place(anchor: box(24, 860), tooltip: tooltip, viewport: phone).top == 842)
    }
}

@MainActor
struct TrailingDraftTests {
    private func block(_ id: String, status: BlockStatus, responded: Bool = false, isLoading: Bool = false) -> ConversationBlock {
        let messages = responded ? [Message(aiVendor: AIVendor(rawValue: "OPENAI"), text: "", messageId: "m-\(id)")] : []
        return ConversationBlock(conversationBlockId: id, prompt: "", responseMessages: messages, isLoading: isLoading, status: status)
    }

    private func store(_ blocks: [ConversationBlock]) -> ConversationStore {
        let store = ConversationStore()
        store.blocks = blocks
        return store
    }

    @Test func anEmptyLastDraftIsTheTrailingDraft() {
        let store = store([block("done", status: .resolved, responded: true), block("draft", status: .draft)])
        #expect(store.trailingDraft?.conversationBlockId == "draft")
    }

    @Test func aBlockStartingToGenerateIsNotADraft() {
        let store = store([block("done", status: .resolved, responded: true), block("generating", status: .draft, isLoading: true)])
        #expect(store.trailingDraft == nil)
    }

    @Test func aResolvedLastBlockLeavesNoDraft() {
        #expect(store([block("done", status: .resolved, responded: true)]).trailingDraft == nil)
    }

    @Test func followingUpReusesAnEmptyDraft() {
        let store = store([block("done", status: .resolved, responded: true), block("draft", status: .draft)])
        store.followUp(fromBlock: "done", messageId: "m1")
        #expect(store.blocks.map(\.conversationBlockId) == ["done", "draft"])
        #expect(store.getSelectedResponse(for: "draft") == "m1")
    }

    @Test func followingUpAddsADraftAfterAResolvedBlock() {
        let store = store([block("done", status: .resolved, responded: true)])
        store.followUp(fromBlock: "done", messageId: "m1")
        #expect(store.blocks.count == 2)
        #expect(store.trailingDraft?.conversationBlockId == store.blocks[1].conversationBlockId)
    }
}

struct AgentDesktopLinkTests {
    private var webApp: String { AppConfig.webAppURL.absoluteString }

    @Test func anAgentLinksToItsOwnWebPage() {
        #expect(AgentDesktopNoticeView.desktopURL(graphId: "GRP1") == "\(webApp)/agents/GRP1")
    }

    @Test func noAgentLinksToTheCreatePage() {
        #expect(AgentDesktopNoticeView.desktopURL(graphId: nil) == "\(webApp)/agents/new")
    }
}

struct AgentDefaultTests {
    private func agent(_ id: String, system: Bool, isDefault: Bool) -> Agent {
        Agent(graphId: id, name: id, isDefault: isDefault, entryPoint: "", maxIterations: 1, edges: "", nodes: [], isSystem: system)
    }

    @Test func theDevicePickWinsWhileItExists() {
        let list = [agent("own", system: false, isDefault: true), agent("sys", system: true, isDefault: true)]
        #expect(Agent.effectiveDefaultId(list, selectedAgentId: "sys") == "sys")
    }

    @Test func aPickThatNoLongerExistsFallsBackToTheOwnDefault() {
        let list = [agent("sys", system: true, isDefault: true), agent("own", system: false, isDefault: true)]
        #expect(Agent.effectiveDefaultId(list, selectedAgentId: "gone") == "own")
    }

    @Test func theSystemDefaultIsTheLastResort() {
        let list = [agent("own", system: false, isDefault: false), agent("sys", system: true, isDefault: true)]
        #expect(Agent.effectiveDefaultId(list, selectedAgentId: nil) == "sys")
    }
}

// MARK: - Chrome's text metrics

struct WebTextTests {
    /// Values read from Chrome at the same font and size.
    @Test func normalLineHeightRoundsAscentAndDescentSeparately() {
        #expect(WebLineBox(font: DSFont.ui(16), lineHeight: nil).height == 19)
        #expect(WebLineBox(font: DSFont.ui(14.4), lineHeight: nil).height == 17)
        #expect(WebLineBox(font: DSFont.ui(13), lineHeight: nil).height == 15)
        #expect(WebLineBox(font: DSFont.uiArial(16), lineHeight: nil).height == 18)
    }

    @Test func fractionalFontSizesSurvive() {
        #expect(DSFont.ui(14.4).pointSize == 14.4)
        #expect(DSFont.uiMono(15.2).pointSize == 15.2)
        #expect(DSFont.uiArial(13.6).pointSize == 13.6)
    }

    @Test func hyphensBeforeDigitsBecomeBreakable() {
        #expect("gpt-5".webHyphenBreakable == "gpt-\u{200B}5")
        #expect("voyage-multilingual-2".webHyphenBreakable == "voyage-multilingual-\u{200B}2")
        #expect("no-digits".webHyphenBreakable == "no-digits")
    }

    @Test func breaksChromeRefusesGetAWordJoinerInText() {
        #expect("and/or".webBreakable.hasPrefix("and/\u{2060}or"))
        #expect("and/or".webHyphenBreakable == "and/or")
    }

    @Test func emptyTextStaysEmpty() {
        #expect("".webBreakable.isEmpty)
    }

    /// `Text` lays out exactly as TextKit does with no line-break strategy, which is greedy like
    /// Chrome: same number of lines, each within a space's width of the same length.
    @Test @MainActor func textWrapsGreedilyLikeChrome() {
        final class Sink { var widths: [CGFloat] = [] }
        struct Recorder: TextRenderer {
            let sink: Sink
            func draw(layout: Text.Layout, in context: inout GraphicsContext) {
                sink.widths = layout.map { $0.typographicBounds.width }
            }
        }
        func greedyLines(_ text: String, font: UIFont, width: CGFloat) -> [CGFloat] {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byWordWrapping
            let storage = NSTextStorage(string: text.webBreakable, attributes: [.font: font, .paragraphStyle: paragraph])
            let manager = NSLayoutManager()
            storage.addLayoutManager(manager)
            let container = NSTextContainer(size: CGSize(width: width, height: 100_000))
            container.lineFragmentPadding = 0
            manager.addTextContainer(container)
            manager.ensureLayout(for: container)
            var lines: [CGFloat] = []
            var glyph = 0
            while glyph < manager.numberOfGlyphs {
                var range = NSRange()
                let used = manager.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: &range)
                lines.append(used.width)
                glyph = range.upperBound
            }
            return lines
        }
        let sentences = [
            "Connect your vector database", "What you have connected", "Determine safe automation thresholds",
            "Coverage vs. accuracy", "Latency and cost", "Accuracy or macro-F1", "Expected calibration error",
            "Already set up \u{2014} you can replace it below or continue.",
            "Shared system agent \u{2014} read-only. Fork it to get your own editable copy.",
            "Used to index and search your data. Pick a provider, then one of its models \u{2014} only providers with an embedding API key saved on the Embedding Model API Keys page are listed.",
            "a b c d e f g h i j k l m n o p q r s t u v w x y z", "Hello there I am x",
            "The quick brown fox jumps over the lazy dog so it can go",
        ]
        let font = DSFont.ui(15.2)
        let space = (" " as NSString).size(withAttributes: [.font: font]).width
        var failures: [String] = []
        for sentence in sentences {
            for width in stride(from: CGFloat(90), through: 340, by: 23) {
                let sink = Sink()
                let renderer = ImageRenderer(content:
                    Text(sentence)
                        .font(Font(font as CTFont))
                        .textRenderer(Recorder(sink: sink))
                        .frame(width: width, alignment: .leading)
                )
                _ = renderer.uiImage
                let expected = greedyLines(sentence, font: font, width: width)
                let same = sink.widths.count == expected.count
                    && zip(sink.widths, expected).allSatisfy { abs($0 - $1) <= space + 0.5 }
                if !same { failures.append("\(sentence) @\(width): \(sink.widths) vs \(expected)") }
            }
        }
        #expect(failures.isEmpty, "\(failures.prefix(6))")
    }

    /// A stack shares out a finite height equally when it places its children, which is less than
    /// a tall row's natural height. No text may give up a line for it, as a CSS block wouldn't.
    @Test @MainActor func textKeepsItsLinesWhenAStackSharesOutHeight() {
        let sentence = "Intent: Seeking instructions on how to use JEV models, though the model name or acronym may be misspelled or ambiguous"
        func row(_ fixed: CGFloat) -> some View {
            VStack(alignment: .leading, spacing: 2.4) {
                Text(sentence).webText(12.8, lineHeight: 19.2)
                Color.clear.frame(height: fixed)
            }
        }
        let host = UIHostingController(rootView: VStack(alignment: .leading, spacing: 7.2) {
            row(0)
            row(120)
            row(0)
            Text("short").webText(13.6, lineHeight: 20.4)
        })
        for width in stride(from: CGFloat(200), through: 360, by: 17.3) {
            let natural = host.sizeThatFits(in: CGSize(width: width, height: 100_000))
            let proposed = host.sizeThatFits(in: CGSize(width: width, height: natural.height))
            let squeezed = host.sizeThatFits(in: CGSize(width: width, height: natural.height / 2))
            #expect(abs(proposed.height - natural.height) < 0.5, "at width \(width)")
            #expect(abs(squeezed.height - natural.height) < 0.5, "at width \(width)")
        }
    }

    /// `line-height` read back from Chrome for each font size and ratio.
    @Test(arguments: [
        (15.2, 1.7, 25.84375), (16.8, 1.7, 28.546875), (16, 1.7, 27.1875), (32, 1.7, 54.390625),
        (24, 1.7, 40.796875), (18.72, 1.7, 31.8125), (14.4, 1.7, 24.484375), (15.2, 1.3, 19.75),
        (24, 1.4, 33.59375), (12.8, 1.5, 19.1875), (13.6, 1.6, 21.75)
    ] as [(CGFloat, CGFloat, CGFloat)])
    func unitlessLineHeightsLandOnLayoutUnits(size: CGFloat, ratio: CGFloat, used: CGFloat) {
        #expect(WebLineBox.usedLineHeight(size * ratio, fontSize: size) == used)
    }

    @Test func pixelLineHeightsStayWhole() {
        #expect(WebLineBox.usedLineHeight(20, fontSize: 12.8) == 20)
    }

    /// `min-content` of each string in Chrome at Roboto 15.2.
    @Test(arguments: [
        ("Confusion matrix", 69.234), ("macro-F1", 47.438), ("Per-class recall", 36.688),
        ("text-embedding-3-small", 79.953), ("Frontend/Backend", 124.828), ("A/B", 25.672),
        ("and/or", 45.328), ("0.80", 29.641), ("$210,352", 62.797), ("foo_bar", 51.438),
        ("a.b.c", 32.781), ("a:b", 20.484), ("key=value", 66.719), ("x+y", 23.359), ("(foo)bar", 55.078),
        ("foo,bar", 47.578), ("foo;bar", 47.797), ("50%", 28.219), ("e.g.", 24.625), ("pre-2020", 34.172),
        ("2020-2021", 38.375), ("10-20%", 28.219), ("v1.2-beta", 32.656), ("user@example.com", 134.547),
        ("http://a.com/b", 98.453), ("C++", 27.156), ("what?why", 40.234), ("a\u{2014}b", 11.859),
        ("a\u{2013}b", 18.25), ("one\u{2026}two", 35.297), ("\u{4E2D}\u{6587}\u{5B57}\u{7B26}", 15.203),
        ("don\u{2019}t", 33.063), ("na\u{EF}ve-caf\u{E9}", 39.953)
    ] as [(String, CGFloat)])
    func minContentMatchesChrome(text: String, chrome: CGFloat) {
        let attributes: [NSAttributedString.Key: Any] = [.font: DSFont.ui(15.2)]
        let source = text as NSString
        let widest = WebLineBreak.unbreakableRanges(in: source)
            .map { source.substring(with: $0).size(withAttributes: attributes).width }
            .max() ?? 0
        #expect(abs(LayoutUnit.ceiling(widest) - chrome) < 0.02)
    }

    /// Chrome cuts this source title after "GitHub" in a 328.53pt link at Roboto 12.
    @Test func ellipsisKeepsWholeCharactersThatFit() {
        let title = "Comprehensive project reference for TypeSafe Jev - GitHub\u{306E}Gist"
        let fitted = title.webTruncated(toFit: 328.53, font: DSFont.ui(12))
        #expect(fitted.isTruncated)
        #expect(fitted.text == "Comprehensive project reference for TypeSafe Jev - GitHub")
        #expect(title.webTruncated(toFit: 500, font: DSFont.ui(12)) == (title, false))
    }

    @Test func aWordJoinerAddsNoWidth() {
        let attributes: [NSAttributedString.Key: Any] = [.font: DSFont.ui(15.2)]
        let plain = "and/or".size(withAttributes: attributes).width
        let joined = "and/or".webBreakable.size(withAttributes: attributes).width
        #expect(abs(plain - joined) < 0.25)
    }
}

// MARK: - Composer engine

/// The expected results are what the web's editor does with the same text and keys.
struct ComposerEngineTests {
    private let engine = ComposerEngine.shared

    private func ready() async {
        // A failing engine would otherwise look like plain edits and pass the wrong checks.
        for _ in 0..<200 {
            if engine.input(id: "ready", text: "", selection: NSRange(location: 0, length: 0), range: NSRange(location: 0, length: 0), insert: "(") != nil { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        Issue.record("Engine never loaded")
    }

    private func type(_ insert: String, into text: String, at caret: Int, id: String = UUID().uuidString) -> ComposerEngine.Edit? {
        engine.input(id: id, text: text, selection: NSRange(location: caret, length: 0), range: NSRange(location: caret, length: 0), insert: insert)
    }

    private func backspace(_ text: String, at caret: Int) -> ComposerEngine.Edit? {
        engine.input(id: UUID().uuidString, text: text, selection: NSRange(location: caret, length: 0), range: NSRange(location: caret - 1, length: 1), insert: "")
    }

    private func result(_ edit: ComposerEngine.Edit?, on text: String) -> String? {
        guard let edit else { return nil }
        let out = NSMutableString(string: text)
        for change in edit.changes.reversed() {
            out.replaceCharacters(in: NSRange(location: change.from, length: change.to - change.from), with: change.insert)
        }
        return out as String
    }

    @Test func plainTypingStaysWithTheTextView() async {
        await ready()
        #expect(type("x", into: "abc", at: 3) == nil)
        #expect(backspace("abcx", at: 4) == nil)
        #expect(type("\n", into: "plain line", at: 10) == nil)
    }

    @Test func bracketsCloseThemselves() async {
        await ready()
        let edit = type("(", into: "foo", at: 3)
        #expect(result(edit, on: "foo") == "foo()")
        #expect(edit?.head == 4)
    }

    @Test func typingTheClosingBracketStepsOverTheOneThatWasAdded() async {
        await ready()
        let id = UUID().uuidString
        #expect(result(type("(", into: "foo", at: 3, id: id), on: "foo") == "foo()")
        let edit = type(")", into: "foo()", at: 4, id: id)
        #expect(result(edit, on: "foo()") == "foo()")
        #expect(edit?.head == 5)
    }

    @Test func backspaceRemovesAnEmptyPair() async {
        await ready()
        #expect(result(backspace("foo()", at: 4), on: "foo()") == "foo")
    }

    @Test func aSelectionGetsWrapped() async {
        await ready()
        let edit = engine.input(id: UUID().uuidString, text: "abc", selection: NSRange(location: 0, length: 3), range: NSRange(location: 0, length: 3), insert: "(")
        #expect(result(edit, on: "abc") == "(abc)")
        #expect(edit?.anchor == 1)
        #expect(edit?.head == 4)
    }

    @Test(arguments: [
        ("- item", "- item\n- "), ("1. one", "1. one\n2. "), ("> quote", "> quote\n> ")
    ])
    func returnContinuesMarkup(text: String, expected: String) async {
        await ready()
        #expect(result(type("\n", into: text, at: (text as NSString).length), on: text) == expected)
    }

    @Test func returnOnAnEmptyItemEndsTheList() async {
        await ready()
        let text = "- item\n- "
        let out = result(type("\n", into: text, at: (text as NSString).length), on: text)
        #expect(out?.contains("- \n") != true)
    }

    @Test func aPastedLinkWrapsSelectedText() async {
        await ready()
        let edit = engine.pasteLink(id: UUID().uuidString, text: "click here", selection: NSRange(location: 6, length: 4), pasted: "https://a.com")
        #expect(result(edit, on: "click here") == "click [here](https://a.com)")
        #expect(engine.pasteLink(id: UUID().uuidString, text: "click here", selection: NSRange(location: 6, length: 4), pasted: "not a link") == nil)
        #expect(engine.pasteLink(id: UUID().uuidString, text: "click here", selection: NSRange(location: 6, length: 0), pasted: "https://a.com") == nil)
    }

    private func colors(of text: String) async -> [String: ComposerEngine.Run] {
        await ready()
        let runs: [ComposerEngine.Run] = await withCheckedContinuation { continuation in
            let once = OnceBox(continuation)
            engine.highlight(id: UUID().uuidString, text: text) { once.resume($0) }
        }
        var byText: [String: ComposerEngine.Run] = [:]
        for run in runs { byText[(text as NSString).substring(with: run.range)] = run }
        return byText
    }

    /// Spans read off the web's editor for the same source.
    @Test func coloringMatchesTheWebsTokens() async {
        let text = [
            "# H1 title", "- list item", "", "[link](https://a.com)", "", "| a | b |", "|---|---|", "| 1 | 2 |", "",
            "```python", "def add(a, b):", "    # comment", "    return a + 1.5 + len(\"str\") + True", "```", "",
            "<div class=\"x\">html</div>"
        ].joined(separator: "\n")
        let runs = await colors(of: text)
        #expect(runs["# H1 title"]?.color == .heading)
        #expect(runs["# H1 title"]?.bold == true)
        #expect(runs["- list item"]?.color == .list)
        #expect(runs["| a | b |"]?.color == .heading)
        #expect(runs["def"]?.color == .keyword)
        #expect(runs["def"]?.bold == true)
        #expect(runs["add"]?.color == .variable)
        #expect(runs["# comment"]?.color == .comment)
        #expect(runs["1.5"]?.color == .variable)
        #expect(runs["\"str\""]?.color == .string)
        #expect(runs["True"]?.color == .entity)
        #expect(runs["+"]?.color == .accent)
        #expect(runs["div"]?.color == .tag)
        #expect(runs["class"]?.color == .constant)
        #expect(runs["="]?.color == .accent)
    }

    @Test func aFencedLanguageLoadsOnFirstUse() async {
        let runs = await colors(of: "```rust\nfn main() {}\n```")
        #expect(runs["fn"]?.color == .keyword)
    }

    @Test func matchingBracketsAreMarked() async {
        await ready()
        let marks: [ComposerEngine.BracketMark] = await withCheckedContinuation { continuation in
            engine.brackets(id: UUID().uuidString, text: "foo(bar)", selection: NSRange(location: 7, length: 0)) { continuation.resume(returning: $0) }
        }
        #expect(marks == [.init(from: 7, to: 8, matched: true), .init(from: 3, to: 4, matched: true)])
    }

    @Test func anHTMLTagOffersCompletionsInTheWebsOrder() async {
        await ready()
        let id = UUID().uuidString
        let list: ComposerEngine.CompletionList = await withCheckedContinuation { continuation in
            engine.completions(id: id, text: "x <di", position: 5) { continuation.resume(returning: $0) }
        }
        #expect(list.from == 2)
        #expect(list.options.map(\.label) == ["<div", "<bdi", "<audio", "<details", "<datagrid", "<datalist"])
        #expect(list.options.first?.type == "type")
        let edit = engine.applyCompletion(id: id, text: "x <di", selection: NSRange(location: 5, length: 0), index: 0)
        #expect(result(edit, on: "x <di") == "x <div")
    }

    @Test func plainTextOffersNoCompletions() async {
        await ready()
        let list: ComposerEngine.CompletionList = await withCheckedContinuation { continuation in
            engine.completions(id: UUID().uuidString, text: "hello", position: 5) { continuation.resume(returning: $0) }
        }
        #expect(list.options.isEmpty)
    }
}

struct ComposerStyleSpanTests {
    private func run(_ location: Int, _ length: Int, _ color: ComposerEngine.TokenColor = .keyword) -> ComposerEngine.Run {
        ComposerEngine.Run(range: NSRange(location: location, length: length), color: color, bold: false, underline: false)
    }

    @Test(arguments: [
        ("abc", "abXc", 2, 1), ("abc", "ac", 1, 0), ("", "x", 0, 1), ("x", "", 0, 0), ("same", "same", 4, 0), ("aaa", "aaaa", 3, 1)
    ] as [(String, String, Int, Int)])
    func theEditIsWhatTheTextsDoNotShare(old: String, new: String, location: Int, length: Int) {
        #expect(ComposerStyle.editedRange(from: old, to: new) == NSRange(location: location, length: length))
    }

    @Test func typingInAGapOnlyTouchesTheGap() {
        let span = ComposerStyle.changedSpan(
            [run(0, 3), run(11, 3)], previous: [run(0, 3), run(10, 3)],
            edited: NSRange(location: 5, length: 1), length: 14, lengthChange: 1
        )
        #expect(span.runs == 1..<1)
        #expect(span.characters == NSRange(location: 3, length: 8))
    }

    @Test func aChangedRunIsRestyledWithItsSurroundings() {
        let span = ComposerStyle.changedSpan(
            [run(0, 3), run(5, 3, .string), run(11, 3)], previous: [run(0, 3), run(5, 2, .comment), run(10, 3)],
            edited: NSRange(location: 6, length: 1), length: 14, lengthChange: 1
        )
        #expect(span.runs == 1..<2)
        #expect(span.characters == NSRange(location: 3, length: 8))
    }

    /// Typing `-` over a selected `+`: same range, same color, but the new character has the
    /// typing attributes until it's styled.
    @Test func aTokenReplacedByItsTwinIsStillRestyled() {
        let span = ComposerStyle.changedSpan(
            [run(2, 1, .accent)], previous: [run(2, 1, .accent)],
            edited: NSRange(location: 2, length: 1), length: 5, lengthChange: 0
        )
        #expect(span.runs == 0..<1)
        #expect(span.characters == NSRange(location: 0, length: 5))
    }

    @Test func allRunsGoneClearsToTheEnd() {
        let span = ComposerStyle.changedSpan([], previous: [run(0, 3)], edited: NSRange(location: 0, length: 0), length: 0, lengthChange: -3)
        #expect(span.runs == 0..<0)
        #expect(span.characters == NSRange(location: 0, length: 0))
    }

    @Test func removingARepeatedRunLeavesTheRestAlone() {
        let span = ComposerStyle.changedSpan(
            [run(0, 1), run(2, 1)], previous: [run(0, 1), run(2, 1), run(4, 1)],
            edited: NSRange(location: 3, length: 0), length: 3, lengthChange: -2
        )
        #expect(span.runs == 2..<2)
        #expect(span.characters == NSRange(location: 3, length: 0))
    }
}

/// The highlight callback can fire twice when a fenced language loads, and a continuation can't.
private final class OnceBox: @unchecked Sendable {
    private var continuation: CheckedContinuation<[ComposerEngine.Run], Never>?
    private let lock = NSLock()

    init(_ continuation: CheckedContinuation<[ComposerEngine.Run], Never>) {
        self.continuation = continuation
    }

    func resume(_ runs: [ComposerEngine.Run]) {
        lock.withLock {
            continuation?.resume(returning: runs)
            continuation = nil
        }
    }
}

// MARK: - Dashed borders

struct WebDashedBorderTests {
    /// Chrome's choice: whichever dash count lands the gap nearest 2.
    @Test(arguments: [
        (100.0, 2.0), (102.0, 2.1), (98.0, 1.9)
    ] as [(CGFloat, CGFloat)])
    func theGapStretchesSoDashesComeOutEven(length: CGFloat, gap: CGFloat) {
        #expect(abs(WebDashedBorder.bestGap(strokeLength: length) - gap) < 0.001)
    }
}

// MARK: - Flex rows

/// The web's connector operation rows at phone width: checkbox, method, path, then a description
/// that takes what's left of the line.
struct FlexWrapBaselineRowTests {
    @MainActor private func frames(width: CGFloat, path: CGFloat, warning: Bool = false) -> [String: CGRect] {
        final class Box { var frames: [String: CGRect] = [:] }
        let box = Box()
        func tracked(_ name: String) -> some ViewModifier { Tracker(name: name) { box.frames[name] = $0 } }
        let row = FlexWrapBaselineRow(spacing: 9.6) {
            Color.clear.frame(width: 13, height: 13)
                .modifier(tracked("box"))
                .layoutValue(key: FlexBaseline.self, value: 13)
            Color.clear.frame(width: 34.47, height: 17.19)
                .modifier(tracked("method"))
                .layoutValue(key: FlexBaseline.self, value: 12.6)
            Color.clear.frame(width: path, height: 15)
                .modifier(tracked("path"))
                .layoutValue(key: FlexBaseline.self, value: 12)
            Color.clear.frame(height: 165)
                .modifier(tracked("summary"))
                .layoutValue(key: FlexBaseline.self, value: 12)
                .layoutValue(key: FlexItemSizingKey.self, value: .grow)
            if warning {
                Color.clear.frame(height: 28)
                    .modifier(tracked("warning"))
                    .layoutValue(key: FlexItemSizingKey.self, value: .fullLine)
            }
        }
        .frame(width: width)
        .coordinateSpace(name: "row")
        let host = UIHostingController(rootView: row)
        host.view.frame = CGRect(x: 0, y: 0, width: width, height: 600)
        let window = UIWindow(frame: host.view.frame)
        window.rootViewController = host
        window.isHidden = false
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        window.isHidden = true
        return box.frames
    }

    /// Numbers from Chrome: `/pet/findByStatus` in a 270pt row.
    @Test @MainActor func theDescriptionTakesWhatIsLeftOfTheLine() {
        let frames = frames(width: 270, path: 131.02)
        #expect(abs((frames["method"]?.minX ?? 0) - 22.6) < 0.01)
        #expect(abs((frames["path"]?.minX ?? 0) - 66.67) < 0.01)
        #expect(abs((frames["summary"]?.minX ?? 0) - 207.29) < 0.01)
        #expect(abs((frames["summary"]?.width ?? 0) - 62.71) < 0.01)
    }

    @Test @MainActor func aPathThatDoesNotFitStartsTheNextLine() {
        let frames = frames(width: 270, path: 230)
        #expect(frames["path"]?.minX == 0)
        #expect((frames["path"]?.minY ?? 0) > 17)
        #expect(abs((frames["summary"]?.minX ?? 0) - 239.6) < 0.01)
    }

    @Test @MainActor func aWarningTakesItsOwnLine() {
        let frames = frames(width: 270, path: 115.59, warning: true)
        #expect(frames["warning"]?.minX == 0)
        #expect(frames["warning"]?.width == 270)
        #expect((frames["warning"]?.minY ?? 0) > (frames["summary"]?.maxY ?? .infinity))
    }
}

private struct Tracker: ViewModifier {
    let name: String
    let report: (CGRect) -> Void

    func body(content: Content) -> some View {
        content.onGeometryChange(for: CGRect.self) { $0.frame(in: .named("row")) } action: { report($0) }
    }
}

// MARK: - Inline code

struct InlineCodeTests {
    private func layout(_ markdown: String, width: CGFloat = 300) throws -> (NSLayoutManager, NSTextContainer, NSTextStorage) {
        guard case .text(_, let text, _, _) = try #require(MarkdownParser.segments(for: markdown).first) else {
            throw CancellationError()
        }
        let storage = NSTextStorage(attributedString: text)
        let manager = MarkdownLayoutManager()
        storage.addLayoutManager(manager)
        let container = NSTextContainer(size: CGSize(width: width, height: 10_000))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        manager.ensureLayout(for: container)
        return (manager, container, storage)
    }

    /// Chrome: the `x` of a `<p><code>x</code> text</p>` starts 6.39 in from the chip's edge.
    @Test func paddingInsetsCodeThatStartsALine() throws {
        let (manager, _, storage) = try layout("`x` text")
        let index = (storage.string as NSString).range(of: "x").location
        let x = manager.location(forGlyphAt: manager.glyphIndexForCharacter(at: index)).x
        #expect(abs(x - MarkdownParser.hangingInset - InlineCodeBox.paddingX) < 0.02)
    }

    /// Chrome's `p` with code is 28.84, an `li` 27.84, a heading unchanged, an `h5` 25.84.
    @Test(arguments: [
        ("text `x`", 28.84375), ("text", 28.546875), ("- text `x`", 27.84375), ("- text", 27.1875),
        ("## text `x`", 40.796875), ("##### text `x`", 25.84375)
    ] as [(String, CGFloat)])
    func aLineGrowsToHoldInlineCode(source: String, height: CGFloat) throws {
        // The layout manager doesn't own its text storage.
        let (manager, container, storage) = try layout(source)
        withExtendedLifetime(storage) {
            #expect(abs(manager.usedRect(for: container).height - height) < 0.02)
        }
    }

    /// Chrome's first line for this sentence in a 354pt list item.
    @Test func codeWrapsOntoTheNextLineWholeAndKeepsItsPadding() throws {
        let (manager, _, storage) = try layout("- Avoid alternatives such as `problem`, `technical_problem`, and `other_problem`.", width: 354 + MarkdownParser.hangingInset * 2)
        var firstLine = NSRange()
        _ = manager.lineFragmentRect(forGlyphAt: 0, effectiveRange: &firstLine)
        let characters = manager.characterRange(forGlyphRange: firstLine, actualGlyphRange: nil)
        let text = MarkdownUITextView.withoutLayoutCharacters((storage.string as NSString).substring(with: characters))
        #expect(text.trimmingCharacters(in: .whitespaces) == "Avoid alternatives such as problem,")

        let code = (storage.string as NSString).range(of: "technical_problem").location
        let x = manager.location(forGlyphAt: manager.glyphIndexForCharacter(at: code)).x
        #expect(abs(x - MarkdownParser.hangingInset - InlineCodeBox.paddingX) < 0.02)
    }

    @Test func copiedTextLosesTheLayoutCharacters() throws {
        let (_, _, storage) = try layout("see `text-2` now")
        #expect(MarkdownUITextView.withoutLayoutCharacters(storage.string) == "see text-2 now")
    }
}

// MARK: - Markdown tables

struct MarkdownTableTests {
    private static let jevTable = """
    | Metric | Purpose |
    |---|---|
    | Accuracy or macro-F1 | Overall classification performance |
    | Per-class recall | Detect failures on rare or important classes |
    | Confusion matrix | Find systematically confused options |
    | Brier score | Measure probability quality |
    | Expected calibration error | Compare confidence with actual correctness |
    | Coverage vs. accuracy | Determine safe automation thresholds |
    | Latency and cost | Validate operational benefit |
    """

    private func table(_ markdown: String) throws -> MarkdownTable {
        guard case .table(_, let table, _, _) = try #require(MarkdownParser.segments(for: markdown).first) else {
            throw CancellationError()
        }
        return table
    }

    private func paragraphAlignment(_ cell: NSAttributedString) -> NSTextAlignment? {
        (cell.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.alignment
    }

    /// The same values as the library's TextContainer tests, so the two can't drift apart.
    @Test(arguments: ["12", "1,234", "1,234.50", "$0.12", "-$5", "+3.5", "12%", "−3", "€1.2", "1.5k", "2M", "3.2B", ".5"])
    func aNumberCounts(value: String) {
        #expect(MarkdownTable.isNumericColumn([value]))
    }

    @Test(arguments: ["abc", "12 apples", "v2", "2026-11-04", "12:30", "1.2.3", "#5", "12 ms", "~3"])
    func thisIsNotANumber(value: String) {
        #expect(!MarkdownTable.isNumericColumn([value]))
    }

    @Test func placeholdersAreIgnoredButCannotMakeAColumnNumeric() {
        #expect(MarkdownTable.isNumericColumn(["12", "", "-", "—", "–", "N/A", "n/a"]))
        #expect(!MarkdownTable.isNumericColumn(["", "-", "N/A"]))
        #expect(!MarkdownTable.isNumericColumn([]))
    }

    @Test func oneTextValueMakesTheWholeColumnText() {
        #expect(!MarkdownTable.isNumericColumn(["12", "about 40"]))
    }

    @Test func aNumericColumnAlignsRightHeaderIncluded() throws {
        let table = try table("""
        | Item | Price |
        |---|---|
        | Tea | $3.00 |
        | Coffee | $4.50 |
        """)
        #expect(paragraphAlignment(table.header[0]) == .left)
        #expect(paragraphAlignment(table.header[1]) == .right)
        #expect(paragraphAlignment(table.rows[0][0]) == .left)
        #expect(paragraphAlignment(table.rows[1][1]) == .right)
    }

    @Test func aStackedCardReadsFromTheLeft() throws {
        let table = try table("""
        | Item | Price |
        |---|---|
        | Tea | $3.00 |
        """)
        #expect(paragraphAlignment(table.stackedRows[0][1]) == .left)
    }

    @Test func anExplicitLeftAlignmentWinsToo() throws {
        let table = try table("""
        | Item | Price |
        |---|:--|
        | Tea | 3 |
        """)
        #expect(paragraphAlignment(table.rows[0][1]) == .left)
    }

    @Test func explicitLeftColumnsAreFoundPerTableOutsideCode() {
        let source = """
        ```
        |:--|:--|
        ```
        | a | b |
        |---|:--|
        | 1 | 2 |

        > | c | d |
        > |:--|--:|
        > | 3 | 4 |
        """
        #expect(MarkdownTable.explicitLeftColumns(in: source) == [[1], [0]])
    }

    @Test func anAlignmentSetInTheMarkdownWins() throws {
        let table = try table("""
        | Item | Price |
        |---|:--:|
        | Tea | 3 |
        """)
        #expect(paragraphAlignment(table.rows[0][1]) == .center)
    }

    /// Chrome's column boxes for this table in a 354pt container.
    @Test func columnsShareTheWidthLikeAutoTableLayout() throws {
        let widths = try table(Self.jevTable).columnWidths(available: 354)
        #expect(abs(widths[0] - 141.5) < 0.06)
        #expect(abs(widths[1] - 211.5) < 0.06)
    }

    @Test func aTableThatFitsKeepsItsNaturalWidth() throws {
        let widths = try table("| A | B |\n|---|---|\n| one | two |").columnWidths(available: 354)
        #expect(widths.reduce(0, +) < 150)
    }

    @Test func aTableThatCannotShrinkOverflows() throws {
        let word = "unbreakablewordunbreakablewo"
        let source = "| \(word) | \(word) |\n|---|---|\n| \(word) | \(word) |"
        // 28 scalars of plain letters count as a token, so these wrap anywhere down to the floor.
        let widths = try table(source).columnWidths(available: 100)
        #expect(widths == [112, 112])
    }

    @Test func alignmentsReachTheCellsAndLabels() throws {
        let parsed = try table("| A | B |C|\n|---|--:|:-:|\n| a | 2 |3|")
        func alignment(_ text: NSAttributedString) -> NSTextAlignment? {
            (text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.alignment
        }
        #expect(alignment(parsed.rows[0][0]) == .left)
        #expect(alignment(parsed.rows[0][1]) == .right)
        #expect(alignment(parsed.rows[0][2]) == .center)
        #expect(alignment(parsed.header[2]) == .center)
    }

    /// UA-13: a `--:` column's label and value sat against the right edge of the cards.
    @Test func aStackedCardIgnoresTheMarkdownsAlignment() throws {
        let parsed = try table("""
        | Product | Probable status | Reason |
        |---|---:|:-:|
        | Mobile app | Not affected | Uses a different stack |
        """)
        for column in 0..<3 {
            #expect(paragraphAlignment(parsed.labels[column]) == .left)
            #expect(paragraphAlignment(parsed.stackedRows[0][column]) == .left)
        }
        #expect(paragraphAlignment(parsed.rows[0][1]) == .right)
        #expect(paragraphAlignment(parsed.header[2]) == .center)
    }

    @Test(arguments: [
        ("PostgreSQL/MySQL", true), ("getUserProfileData", true), ("hello", false),
        ("$210,352,000,000", false), ("internationalization", false),
        ("Pneumonoultramicroscopic", true), ("abcdefgh-ijklmnop", false)
    ])
    func longTokensMatchTheWeb(run: String, expected: Bool) {
        #expect(MarkdownTable.isLongToken(run) == expected)
    }
}

// MARK: - Localization

struct LocalizationCoverageTests {
    /// Every `{{count}}` key used in code resolves through the plural suffix.
    @Test func pluralsPickOneOrOther() {
        #expect(L("conversation.activity.header.searches", ["count": 1]) == "1 search")
        #expect(L("conversation.activity.header.searches", ["count": 3]) == "3 searches")
    }

    @Test func placeholdersAreFilled() {
        #expect(L("conversation.stopReason.finished", ["reason": "stop"]) == "Finished · stop")
    }

    @Test func stoppedNoteHasItsCopy() {
        #expect(L("conversation.stopReason.cancelled") == "You stopped this response.")
    }

    /// A key typed in code but missing from the strings file shows as the raw key.
    @Test func everyLiteralKeyInTheAppResolves() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("AI Wrapper")
        let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }
        #expect(files.count > 10)
        let call = try Regex(#"\bL\("((?:[^"\\]|\\.)*)""#)
        for file in files {
            for match in try String(contentsOf: file, encoding: .utf8).matches(of: call) {
                guard let key = match.output[1].substring.map(String.init), !key.contains("\\(") else { continue }
                let resolves = L(key) != key || (L(key, ["count": 1]) != key && L(key, ["count": 2]) != key)
                #expect(resolves, "\(key) in \(file.lastPathComponent)")
            }
        }
    }
}

// MARK: - Attachments (attachmentFormat.test.tsx)

@Suite("Attachment format")
struct AttachmentFormatTests {
    private func bytes(_ parts: Any...) -> [UInt8] {
        parts.flatMap { part -> [UInt8] in
            if let text = part as? String { return text.unicodeScalars.map { UInt8($0.value) } }
            return part as? [UInt8] ?? []
        }
    }

    private func pad(_ head: [UInt8], _ length: Int = 64) -> [UInt8] {
        head + [UInt8](repeating: 0, count: max(0, length - head.count))
    }

    private func ftyp(_ brand: String) -> [UInt8] { pad(bytes([0, 0, 0, 0x18] as [UInt8], "ftyp", brand)) }

    private func bmp(_ dibHeaderSize: UInt8) -> [UInt8] {
        pad(bytes("BM", [0, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, dibHeaderSize, 0, 0, 0] as [UInt8]))
    }

    @Test func recognisesEveryFormatTheBackendConverts() {
        let supported: [(String, [UInt8])] = [
            ("JPEG", pad([0xFF, 0xD8, 0xFF, 0xE0])),
            ("PNG", pad(bytes([0x89] as [UInt8], "PNG", [0x0D, 0x0A, 0x1A, 0x0A] as [UInt8]))),
            ("GIF", pad(bytes("GIF89a"))),
            ("WebP", pad(bytes("RIFF", [0, 0, 0, 0] as [UInt8], "WEBP"))),
            ("HEIC", ftyp("heic")),
            ("HEIF", ftyp("mif1")),
            ("AVIF", ftyp("avif")),
            ("TIFF", pad(bytes("II*", [0] as [UInt8]))),
            ("big-endian TIFF", pad(bytes("MM", [0] as [UInt8], "*"))),
            ("BMP", bmp(40)),
            ("PSD", pad(bytes("8BPS", [0, 1] as [UInt8]))),
            ("JPEG 2000", pad(bytes([0, 0, 0, 0x0C] as [UInt8], "jP  ", [0x0D, 0x0A, 0x87, 0x0A] as [UInt8]))),
            ("PPM", pad(bytes("P6\n640 480\n255\n"))),
            ("QOI", pad(bytes("qoif"))),
            ("CR3", ftyp("crx ")),
            ("CRW", pad(bytes("II", [0x1A, 0, 0, 0] as [UInt8], "HEAPCCDR"))),
            ("RAF", pad(bytes("FUJIFILMCCD-RAW 0201"))),
            ("ORF", pad(bytes("IIRO", [8, 0, 0, 0] as [UInt8]))),
            ("RW2", pad(bytes("IIU", [0] as [UInt8]))),
            ("X3F", pad(bytes("FOVb"))),
            ("MRW", pad(bytes([0] as [UInt8], "MRM"))),
            ("IIQ", pad(bytes("IIII", "CwaR")))
        ]
        for (name, head) in supported {
            #expect(AttachmentFormat.sniff(head) == .supported, "\(name)")
        }
    }

    @Test func turnsDownFormatsTheBackendRefuses() {
        var emf = pad([1, 0, 0, 0])
        emf.replaceSubrange(40..<44, with: bytes(" EMF"))
        let unsupported: [(String, [UInt8])] = [
            ("SVG", pad(bytes("<svg xmlns=\"http://www.w3.org/2000/svg\">"))),
            ("SVG after a BOM and a prolog", pad(bytes([0xEF, 0xBB, 0xBF] as [UInt8], "  <?xml version=\"1.0\"?><svg>"))),
            ("HTML", pad(bytes("<!doctype html><html>"))),
            ("PDF", pad(bytes("%PDF-1.7"))),
            ("EPS", pad(bytes("%!PS-Adobe-3.0 EPSF-3.0"))),
            ("ICO", pad([0, 0, 1, 0, 1, 0])),
            ("ICNS", pad(bytes("icns"))),
            ("JPEG XL", pad([0xFF, 0x0A])),
            ("JPEG XL container", pad(bytes([0, 0, 0, 0x0C] as [UInt8], "JXL ", [0x0D, 0x0A, 0x87, 0x0A] as [UInt8]))),
            ("OpenEXR", pad([0x76, 0x2F, 0x31, 0x01])),
            ("Radiance HDR", pad(bytes("#?RADIANCE\n"))),
            ("PSB", pad(bytes("8BPS", [0, 2] as [UInt8]))),
            ("GIMP XCF", pad(bytes("gimp xcf v011"))),
            ("ZIP", pad(bytes("PK", [3, 4] as [UInt8]))),
            ("MOV", ftyp("qt  ")),
            ("MP4", ftyp("isom")),
            ("WebM", pad([0x1A, 0x45, 0xDF, 0xA3])),
            ("AVI", pad(bytes("RIFF", [0, 0, 0, 0] as [UInt8], "AVI "))),
            ("JPEG XR", pad(bytes("II", [0xBC, 0x01] as [UInt8]))),
            ("WMF", pad([0xD7, 0xCD, 0xC6, 0x9A])),
            ("EMF", emf),
            ("SGI", pad([0x01, 0xDA, 0x01, 0x01])),
            ("Sun raster", pad([0x59, 0xA6, 0x6A, 0x95])),
            ("MNG", pad(bytes([0x8A] as [UInt8], "MNG", [0x0D, 0x0A] as [UInt8]))),
            ("JNG", pad(bytes([0x8B] as [UInt8], "JNG", [0x0D, 0x0A] as [UInt8]))),
            ("XPM", pad(bytes("/* XPM */\nstatic char *x[] = {"))),
            ("XBM", pad(bytes("#define x_width 8\n")))
        ]
        for (name, head) in unsupported {
            #expect(AttachmentFormat.sniff(head) == .unsupported, "\(name)")
        }
    }

    @Test func tellsTGAApartFromIcoAndPFMFromPAM() {
        #expect(AttachmentFormat.sniff(pad([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0x30, 0, 0x18, 0])) == nil)
        #expect(AttachmentFormat.sniff(pad([0x3C, 0, 2, 0, 0, 0])) == nil)
        #expect(AttachmentFormat.sniff(pad([0, 0, 2, 0, 1, 0, 0x20, 0x20])) == .unsupported)
        #expect(AttachmentFormat.sniff(pad(bytes("Pf\n2 2\n-1.0\n"))) == .supported)
        #expect(AttachmentFormat.sniff(pad(bytes("PF\n2 2\n-1.0\n"))) == nil)
        #expect(AttachmentFormat.sniff(pad(bytes("P7\nWIDTH 2\n"))) == .unsupported)
    }

    @Test func saysNothingAboutBytesItDoesNotKnow() {
        #expect(AttachmentFormat.sniff(pad(bytes("hello world"))) == nil)
        #expect(AttachmentFormat.sniff(pad(bytes("BM not a bitmap header"))) == nil)
        #expect(AttachmentFormat.sniff(ftyp("zzzz")) == nil)
        #expect(AttachmentFormat.sniff(ftyp("mif2")) == nil)
        #expect(AttachmentFormat.sniff([]) == nil)
    }

    @Test func fallsBackToTypeAndName() {
        #expect(AttachmentFormat.fromTypeAndName(type: "image/x-tga", fileName: "scan.tga") == .supported)
        #expect(AttachmentFormat.fromTypeAndName(type: "", fileName: "scan.TGA") == .supported)
        #expect(AttachmentFormat.fromTypeAndName(type: "application/octet-stream", fileName: "IMG_1.CR3") == .supported)
        #expect(AttachmentFormat.fromTypeAndName(type: "image/svg+xml", fileName: "logo.svg") == .unsupported)
        #expect(AttachmentFormat.fromTypeAndName(type: "image/x-icon", fileName: "favicon.ico") == .unsupported)
        #expect(AttachmentFormat.fromTypeAndName(type: "image/jxl", fileName: "photo.jxl") == .unsupported)
        #expect(AttachmentFormat.fromTypeAndName(type: "application/pdf", fileName: "scan.pdf") == .unsupported)
        #expect(AttachmentFormat.fromTypeAndName(type: "", fileName: "notes.txt") == .unsupported)
        #expect(AttachmentFormat.fromTypeAndName(type: "image/vnd.ms-photo", fileName: "capture.jxr") == .unsupported)
    }

    @Test func goesByTheBytesWhateverTheNameOrType() {
        let png = Data(bytes([0x89] as [UInt8], "PNG", [0x0D, 0x0A, 0x1A, 0x0A] as [UInt8], "rest"))
        #expect(AttachmentFormat.check(png, type: "application/pdf", fileName: "scan.pdf") == .supported)
        #expect(AttachmentFormat.check(Data("<svg/>".utf8), type: "image/png", fileName: "logo.png") == .unsupported)
        #expect(AttachmentFormat.check(Data(ftyp("heic")), type: "", fileName: "IMG_0001.HEIC") == .supported)
        #expect(AttachmentFormat.check(Data("xyz".utf8), type: "", fileName: "scan.tga") == .supported)
        #expect(AttachmentFormat.check(Data("xyz".utf8), type: "", fileName: "data.bin") == .unsupported)
        #expect(AttachmentFormat.check(Data(), type: "image/jpeg", fileName: "photo.jpg") == .unsupported)
    }

    @Test func recognisesPDFs() {
        #expect(AttachmentFormat.isPDF(type: "application/pdf", fileName: "a"))
        #expect(AttachmentFormat.isPDF(type: "", fileName: "A.PDF"))
        #expect(AttachmentFormat.isPDF(type: "application/octet-stream", fileName: "a.pdf"))
        #expect(!AttachmentFormat.isPDF(type: "image/png", fileName: "a.pdf"))
    }
}

@Suite("Attachment intake")
struct AttachmentIntakeTests {
    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0])
    private let pdf = Data("%PDF-1.4".utf8)

    private func image(_ name: String = "a.png") -> PickedAttachment {
        PickedAttachment(data: png, fileName: name, mediaType: "image/png")
    }

    private func document(_ name: String = "a.pdf", size: Int? = nil) -> PickedAttachment {
        PickedAttachment(data: size.map { Data(count: $0) } ?? pdf, fileName: name, mediaType: "application/pdf")
    }

    @Test func refusesUnsupportedFormatsAndKeepsTheRest() {
        let svg = PickedAttachment(data: Data("<svg/>".utf8), fileName: "logo.svg", mediaType: "image/svg+xml")
        let intake = AttachmentIntake([svg, image()], pendingCount: 0, pendingPDFs: 0)
        #expect(intake.rejectedNames == ["logo.svg"])
        #expect(intake.accepted.map(\.fileName) == ["a.png"])
    }

    @Test func refusesOversizedPDFsOnly() {
        let intake = AttachmentIntake(
            [document("big.pdf", size: AttachmentRef.maxPDFBytes + 1), document("edge.pdf", size: AttachmentRef.maxPDFBytes)],
            pendingCount: 0, pendingPDFs: 0
        )
        #expect(intake.pdfTooLarge)
        #expect(intake.accepted.map(\.fileName) == ["edge.pdf"])
    }

    @Test func dropsPDFsPastTheirBudgetKeepingImages() {
        let intake = AttachmentIntake([document("1.pdf"), image(), document("2.pdf")], pendingCount: 4, pendingPDFs: 4)
        #expect(intake.pdfLimitReached)
        #expect(intake.accepted.map(\.fileName) == ["1.pdf", "a.png"])
    }

    @Test func keepsOnlyWhatFitsInTheMessage() {
        let intake = AttachmentIntake([image("1.png"), image("2.png"), image("3.png")], pendingCount: 8, pendingPDFs: 0)
        #expect(intake.limitReached)
        #expect(intake.accepted.map(\.fileName) == ["1.png", "2.png"])
    }

    @Test func aFullMessageTakesNothing() {
        let intake = AttachmentIntake([image()], pendingCount: 10, pendingPDFs: 0)
        #expect(intake.limitReached)
        #expect(intake.accepted.isEmpty)
    }
}

// MARK: - Settings and startup

@Suite("Key settings")
struct KeySettingsTests {
    @Test func liveModelListsOnlyApplyToTheLegacyVendors() {
        let catalog = ProviderInfo(id: "xai", displayName: "xAI", native: true, models: [.init(name: "grok-chat", supportsTools: true)])
        let live: [AIVendor: [String]] = [AIVendor(rawValue: "xai"): ["grok-chat", "grok-imagine-image"], .claude: ["claude-live"]]
        #expect(AISettingsView.modelOptions(vendor: "xai", live: live, catalog: catalog) == ["grok-chat"])
        #expect(AISettingsView.modelOptions(vendor: "CLAUDE", live: live, catalog: nil) == ["claude-live"])
        #expect(AISettingsView.modelOptions(vendor: "GEMINI", live: live, catalog: nil).isEmpty)
    }

    @Test func anEmptyLiveListFallsBackToTheCatalog() {
        let catalog = ProviderInfo(id: "gemini", displayName: "Gemini", native: true, models: [.init(name: "gemini-chat", supportsTools: true)])
        #expect(AISettingsView.modelOptions(vendor: "GEMINI", live: [.gemini: []], catalog: catalog) == ["gemini-chat"])
    }

    @Test func anEmptyDetailFallsBackToTheStatus() {
        #expect(VendorKeySaveResult(success: false, detail: "Account suspended", status: "invalid").message == "Account suspended")
        #expect(VendorKeySaveResult(success: false, detail: "", status: "invalid").message == "invalid")
        #expect(VendorKeySaveResult(success: false, detail: nil, status: "invalid").message == "invalid")
    }

    @Test func statusTextReadsLikeTheBrowsers() {
        #expect(APIError(status: 500, message: "").statusText == "Internal Server Error")
        #expect(APIError(status: 404, message: "").statusText == "Not Found")
    }
}

@Suite("Startup")
struct StartupTests {
    @Test func removesOlderBuildsCachedAccountDataOnly() throws {
        let name = "LegacyDefaultsTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let stale = [
            "customerId", "CU1_ai_preferences", "CU1_ai_vendor_models", "CU1_instructions", "CU1_selected_agent_id",
            "CU1_selected_instruction_id", "CU1_system_prompt", "CU1_vendor_api_key_statuses"
        ]
        stale.forEach { defaults.set("value", forKey: $0) }
        defaults.set("dark", forKey: "theme")

        LegacyDefaults.removeStaleValues(from: defaults)

        #expect(stale.allSatisfy { defaults.object(forKey: $0) == nil })
        #expect(defaults.string(forKey: "theme") == "dark")
    }

    @Test func aCapturedPhotoPassesTheFormatCheck() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { _ in }
        let data = try #require(image.jpegData(compressionQuality: 0.9))
        let intake = AttachmentIntake([PickedAttachment(data: data, fileName: "image.jpg", mediaType: "image/jpeg")], pendingCount: 0, pendingPDFs: 0)
        #expect(intake.accepted.count == 1)
    }

    @Test func composerTextGrowsItUpToHalfTheScreenThenScrolls() {
        // The box takes 72 around its text: 10 of padding top and bottom, its 1pt borders, the
        // 6 gap and the 44 controls row
        #expect(ComposerView.boxFrame == 72)
        let tallestText = (800 - mobileHeaderHeight - 8) / 2 - 72
        // One line at least, its text's height up to the limit, then it scrolls
        #expect(ComposerView.textViewHeight(textHeight: 0, lineHeight: 33.6, screenHeight: 800) == 33.6)
        #expect(ComposerView.textViewHeight(textHeight: 100.8, lineHeight: 33.6, screenHeight: 800) == 100.8)
        #expect(ComposerView.textViewHeight(textHeight: 2000, lineHeight: 33.6, screenHeight: 800) == tallestText)
        // Before the screen is measured: one line
        #expect(ComposerView.textViewHeight(textHeight: 2000, lineHeight: 33.6, screenHeight: 0) == 33.6)
    }

    /// The editor is as tall as the text it reports, so a height reported mid-restyle that counts
    /// only the lines around the edit drops the editor for a frame.
    @Test @MainActor func composerReportsOnlyGrowthWhileLinesAreAdded() async throws {
        for _ in 0..<200 {
            if ComposerEngine.shared.input(id: "ready", text: "", selection: NSRange(location: 0, length: 0), range: NSRange(location: 0, length: 0), insert: "(") != nil { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        var text = ""
        var reported: [CGFloat] = []
        let host = UIHostingController(rootView: ComposerTextView(
            text: Binding(get: { text }, set: { text = $0 }),
            isFocused: .constant(true),
            focusRequest: 0,
            focusEndRequest: 0,
            onChange: { _ in },
            onPasteImages: { _ in },
            onContentHeightChange: { reported.append($0) }
        ).frame(width: 414, height: 403))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 414, height: 403))
        window.rootViewController = host
        window.isHidden = false
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        func editor(in view: UIView) -> ComposerUITextView? {
            view as? ComposerUITextView ?? view.subviews.lazy.compactMap(editor).first
        }
        let view = try #require(editor(in: host.view))
        for typed in ["ggh", "\n", "\n", "hhhj", "\n", "\n", "\n", "ghhhhj", "\n", "\n"] {
            view.selectedTextRange = view.textRange(from: view.endOfDocument, to: view.endOfDocument)
            view.insertText(typed)
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        #expect(reported.count >= 7)
        #expect(reported == reported.sorted(), "\(reported)")
    }
}

@Suite("After a failed stream")
struct StreamRecoveryTests {
    private let failed = StreamGenerationError(message: "Provider said no")

    @Test func aFailureWithNoTextHasNothingToPollFor() {
        #expect(ConversationStore.recoveryAttempts(after: failed, streamedText: false) == 0)
    }

    @Test func aFailureAfterSomeTextLooksOnce() {
        #expect(ConversationStore.recoveryAttempts(after: failed, streamedText: true) == 1)
    }

    @Test func aCutStreamKeepsPolling() {
        #expect(ConversationStore.recoveryAttempts(after: StreamTruncatedError(), streamedText: false) == 36)
        #expect(ConversationStore.recoveryAttempts(after: URLError(.networkConnectionLost), streamedText: true) == 36)
    }

    private func event(_ json: String) throws -> ActivityEvent {
        let value = try #require(JSONValue.parse(Data(json.utf8)))
        return try #require(ActivityEvent(json: value))
    }

    @Test func theSavedActivityLogReplacesTheCutOne() throws {
        let start = try event(#"{"v":2,"at":0,"type":"turn.start"}"#)
        let end = try event(#"{"v":2,"at":900,"type":"turn.end","outcome":"completed"}"#)
        var saved = Message(aiVendor: AIVendor(rawValue: "OPENAI"), text: "done", messageId: "m-1")
        saved.activity = [start, end]
        #expect(ConversationStore.savedActivity(saved, over: [start]) == [start, end])
    }

    @Test func aReplySavedWithoutALogKeepsWhatStreamed() throws {
        let start = try event(#"{"v":2,"at":0,"type":"turn.start"}"#)
        let saved = Message(aiVendor: AIVendor(rawValue: "OPENAI"), text: "done", messageId: "m-1")
        #expect(ConversationStore.savedActivity(saved, over: [start]) == [start])
    }
}

@Suite("One-line truncation")
struct WebTruncatedLineTests {
    @Test func tellsPrimaryFontTextFromFallbackText() {
        let font = DSFont.ui(14)
        #expect(font.coversAllCharacters(in: "Plain title - 2026"))
        #expect(!font.coversAllCharacters(in: "日本語のタイトル"))
        #expect(!font.coversAllCharacters(in: "Mixed 日本語"))
    }

    @Test func cutsWholeCharactersBesideThePrimaryFontsEllipsis() {
        let font = DSFont.ui(14)
        let title = String(repeating: "語", count: 40)
        let fitted = title.webTruncated(toFit: 100, font: font)
        #expect(fitted.isTruncated)
        let width = (fitted.text + "\u{2026}").size(withAttributes: [.font: font]).width
        #expect(width <= 100)
        let oneMore = (fitted.text + "語\u{2026}").size(withAttributes: [.font: font]).width
        #expect(oneMore > 100)
    }
}

@Suite("One account across web and iOS")
struct SharedAccountTests {
    @Test func signInAsksForTheWebAccount() {
        let user = Auth0Service.AuthUser(sub: "apple|1", email: "a@b.c", name: "A", picture: nil)
        #expect(OnboardUserService.request(for: user).client == "REACT_APP")
    }

    @Test func generationsIdentifyAsTheWebClient() {
        #expect(ClientID.app == "REACT_APP")
    }
}

@Suite("Refreshing models")
@MainActor
struct RefreshModelsTests {
    @Test func clearsEveryListAndTheCacheButNotTheSelection() async {
        let store = AIStore()
        let customer = "CU-refresh-\(UUID().uuidString)"
        let key = StorageSuffix.customerKey(customer, StorageSuffix.aiVendorModels)
        CacheStore.shared.write([AIVendorModelList(aiVendor: .openai, modelsList: ["stale"])], key: key)
        store.attach(customerId: customer)
        #expect(store.modelsByVendor[.openai] == ["stale"])
        store.setSelectedModel(for: .openai, model: "gpt-saved")

        await store.refreshModels(token: "t", vendors: [])

        #expect(store.modelsByVendor.isEmpty)
        #expect(CacheStore.shared.read([AIVendorModelList].self, key: key) == nil)
        #expect(store.selectedModel(for: .openai) == "gpt-saved")
    }
}

@Suite("Logout wipe")
@MainActor
struct LogoutWipeTests {
    @Test func leavesOnlyTheTheme() async throws {
        let domain = "LogoutWipeTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        defaults.set("dark", forKey: "theme")
        defaults.set("x", forKey: "anything")

        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Data("picked".utf8).write(to: temporary.appendingPathComponent("picked.pdf"))

        let cacheKey = "CU-wipe-\(UUID().uuidString)_instructions"
        CacheStore.shared.writeString("cached", key: cacheKey)
        let url = try #require(URL(string: "https://example.test/api/v1/chat"))
        let response = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil))
        URLCache.shared.storeCachedResponse(CachedURLResponse(response: response, data: Data("conversation".utf8)), for: URLRequest(url: url))
        #expect(URLCache.shared.cachedResponse(for: URLRequest(url: url)) != nil)

        LocalSessionData.wipe(defaults: defaults, domain: domain, temporaryDirectory: temporary)

        #expect(defaults.string(forKey: "theme") == "dark")
        #expect(defaults.string(forKey: "anything") == nil)
        #expect(CacheStore.shared.readString(cacheKey) == nil)
        #expect(try FileManager.default.contentsOfDirectory(atPath: temporary.path).isEmpty)
        // `URLCache` applies changes in the background, so it gets a moment to settle.
        var stillCached = true
        for _ in 0..<40 where stillCached {
            stillCached = URLCache.shared.cachedResponse(for: URLRequest(url: url)) != nil
            if stillCached { try await Task.sleep(nanoseconds: 50_000_000) }
        }
        #expect(!stillCached)
    }

    @Test func apiResponsesNeverReachTheDiskCache() {
        #expect(APIClient.session.configuration.urlCache == nil)
    }

    @Test func storesForgetTheAccount() {
        let history = HistoryStore()
        history.items = [ConversationSummary(conversationId: "c1")]
        history.pinned = history.items
        history.lastKey = "k"
        history.hasMore = true
        history.clear()
        #expect(history.items.isEmpty && history.pinned.isEmpty && history.lastKey == nil && !history.hasMore)

        let memories = MemoriesStore()
        memories.memories = [CustomerMemory(memoryId: "MEM#1", text: "private fact", kind: .core)]
        memories.projects = [Project(projectId: "PRJa", name: "Private project")]
        memories.clear()
        #expect(memories.memories.isEmpty && memories.projects.isEmpty)
    }
}

// MARK: - Memories (pages/MemoryPage)

@Suite("Memories")
@MainActor
struct MemoryModelTests {
    private func decode(_ json: String) throws -> CustomerMemory {
        try JSONDecoder().decode(CustomerMemory.self, from: Data(json.utf8))
    }

    @Test func aMemoryFromBeforePlacementsAppliesInProfile() throws {
        let memory = try decode(#"{"memoryId":"MEM#1","text":"Lives in Lisbon.","kind":"CORE","sourceType":"CONVERSATION","createdAt":"t","updatedAt":"t"}"#)
        #expect(memory.placements == [MemoryPlacement(projectId: nil, kind: .core)])
        #expect(memory.version == 1 && !memory.tracked && memory.hitCount == 0)
        #expect(memory.isProfile)
    }

    @Test func listsHoldWhatAppliesThereNewestFirst() throws {
        let shared = CustomerMemory(memoryId: "MEM#s", text: "s", kind: .core, updatedAt: "2026-02-01",
                                    placements: [MemoryPlacement(projectId: "PRJa", kind: .core), MemoryPlacement(projectId: "PRJb", kind: .episodic)])
        let old = CustomerMemory(memoryId: "MEM#o", text: "o", kind: .core, updatedAt: "2026-01-01")
        let new = CustomerMemory(memoryId: "MEM#n", text: "n", kind: .core, updatedAt: "2026-03-01")
        let all = [old, shared, new]

        #expect(MemoryScope.profileCore.memories(in: all).map(\.memoryId) == ["MEM#n", "MEM#o"])
        #expect(MemoryScope.project("PRJb").memories(in: all).map(\.memoryId) == ["MEM#s"])
        #expect(MemoryScope.project("PRJb").placement(of: shared)?.kind == .episodic)
        #expect(MemoryScope.profile(.episodic).memories(in: all).isEmpty)
        #expect(memoryCounts(all) == ["core": 2, "episodic": 0, "PRJa": 1, "PRJb": 1])
        #expect(MemoryScope.of(shared) == .project("PRJa"))
        #expect(!shared.isProfile)
    }

    /// MEM-001: an unencoded "#" made every delete reach /memories/MEM.
    @Test func idsKeepTheirHashInTheURL() {
        let url = MemoriesService.url("MEM#3f2a", "usage", query: [URLQueryItem(name: "cursor", value: "a b")])
        #expect(url.path(percentEncoded: true).hasSuffix("/api/v1/memories/MEM%233f2a/usage"))
        #expect(url.fragment == nil)
        #expect(url.query == "cursor=a%20b")
    }

    @Test func aDeleteResultSaysWhetherTheMemoryIsGone() throws {
        #expect(try JSONDecoder().decode(DeleteMemoryResult.self, from: Data(#"{"status":"success","deleted":false}"#.utf8)).deleted == false)
        let detail = try JSONDecoder().decode(MemoryDetail.self, from: Data(#"""
        {"memory":{"memoryId":"MEM#1","text":"t","kind":"EPISODIC","sourceType":"USER","createdAt":"t","updatedAt":"t","placements":[{"projectId":"PRJa","kind":"EPISODIC"}],"version":2,"tracked":true,"hitCount":3},
         "versions":[{"changeId":"c2","type":"EDITED_BY_YOU","createdAt":"t","version":2,"text":"t","previousText":"s"}],
         "changes":[{"changeId":"m","type":"MOVED","createdAt":"t","from":[{"projectId":null,"kind":"CORE"}],"to":[{"projectId":"PRJa","kind":"EPISODIC"}]}]}
        """#.utf8))
        #expect(detail.memory.placements.first?.projectId == "PRJa")
        #expect(detail.changes.first?.from?.first?.projectId == nil)
        #expect(detail.versions.first?.previousText == "s")
    }

    /// MEM-013: a version added by hand used to read "Edited by you".
    @Test func eachVersionSaysHowItWasMade() {
        func change(_ type: String) -> MemoryChange { MemoryChange(changeId: type, type: type, createdAt: "t", version: 1) }
        #expect(MemoryLabels.changeTitle(change("ADDED_BY_YOU")) == "Added by you")
        #expect(MemoryLabels.changeTitle(change("EDITED_BY_YOU")) == "Edited by you")
        #expect(MemoryLabels.changeTitle(change("UPDATED")) == "Updated from a conversation")
    }

    /// MEM-016: cards and the "history before" note show the year, as formatServerDateOnly does.
    @Test func memoryDatesIncludeTheYear() {
        #expect(MemoryLabels.dateOnly("2026-11-06T09:31:00.342Z").hasSuffix(", 2026"))
        #expect(MemoryLabels.dateOnly(nil).isEmpty)
    }
}

// MARK: - Token refresh, against a fake Auth0

@Suite("Token refresh")
@MainActor
struct TokenRefreshTests {
    private final class MemoryVault: TokenVault {
        var values: [String: String] = [:]
        func get(_ key: String) -> String? { values[key] }
        func set(_ value: String, for key: String) { values[key] = value }
        func delete(_ key: String) { values[key] = nil }
    }

    private final class FakeAuth0 {
        var requests: [String] = []
        var gate: CheckedContinuation<Void, Never>?
        var holdResponses = false
        var respond: () throws -> (Int, String) = { (200, #"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}"#) }

        func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(String(decoding: request.httpBody ?? Data(), as: UTF8.self))
            if holdResponses { await withCheckedContinuation { gate = $0 } }
            let (status, body) = try respond()
            let response = HTTPURLResponse(url: try #require(request.url), statusCode: status, httpVersion: nil, headerFields: nil)
            return (Data(body.utf8), try #require(response))
        }
    }

    private func make(expired: Bool = true) -> (Auth0Service, MemoryVault, FakeAuth0) {
        let vault = MemoryVault()
        let fake = FakeAuth0()
        vault.values = [
            "access_token": "old-access",
            "refresh_token": "old-refresh",
            "expires_at": String(Date().addingTimeInterval(expired ? -10 : 3600).timeIntervalSince1970)
        ]
        return (Auth0Service(vault: vault, send: { try await fake.send($0) }), vault, fake)
    }

    @Test func aFreshTokenNeedsNoExchange() async throws {
        let (service, _, fake) = make(expired: false)
        #expect(try await service.getAccessTokenSilently() == "old-access")
        #expect(fake.requests.isEmpty)
    }

    @Test func anExpiredTokenIsRefreshedAndTheRotatedRefreshTokenKept() async throws {
        let (service, vault, fake) = make()
        #expect(try await service.getAccessTokenSilently() == "new-access")
        #expect(fake.requests.count == 1)
        #expect(fake.requests[0].contains("refresh_token=old%2Drefresh") || fake.requests[0].contains("refresh_token=old-refresh"))
        #expect(vault.values["refresh_token"] == "new-refresh")
        #expect(try await service.getAccessTokenSilently() == "new-access")
        #expect(fake.requests.count == 1)
    }

    @Test func parallelRequestsShareOneRefresh() async throws {
        let (service, _, fake) = make()
        fake.holdResponses = true
        let callers = (0..<5).map { _ in Task { try await service.getAccessTokenSilently() } }
        while fake.gate == nil { await Task.yield() }
        for _ in 0..<20 { await Task.yield() }
        fake.gate?.resume()
        for caller in callers { #expect(try await caller.value == "new-access") }
        #expect(fake.requests.count == 1)
    }

    @Test(arguments: [400, 401, 403])
    func aRejectedRefreshEndsTheSession(status: Int) async throws {
        let (service, vault, fake) = make()
        fake.respond = { (status, #"{"error":"invalid_grant"}"#) }
        await #expect(throws: Auth0Service.AuthError.self) { try await service.getAccessTokenSilently() }
        #expect(vault.values.isEmpty)
        #expect(!service.hasSession)
    }

    @Test func aNetworkFailureKeepsTheSessionAndTheNextCallRetries() async throws {
        let (service, vault, fake) = make()
        fake.respond = { throw URLError(.notConnectedToInternet) }
        await #expect(throws: URLError.self) { try await service.getAccessTokenSilently() }
        #expect(vault.values["refresh_token"] == "old-refresh")
        fake.respond = { (200, #"{"access_token":"after-retry","expires_in":3600}"#) }
        #expect(try await service.getAccessTokenSilently() == "after-retry")
        #expect(vault.values["refresh_token"] == "old-refresh")
    }

    @Test func aServerErrorKeepsTheSession() async throws {
        let (service, vault, fake) = make()
        fake.respond = { (503, "unavailable") }
        await #expect(throws: APIError.self) { try await service.getAccessTokenSilently() }
        #expect(vault.values["refresh_token"] == "old-refresh")
    }

    @Test func aRefreshFinishingAfterLogoutCannotBringTheSessionBack() async throws {
        let (service, vault, fake) = make()
        fake.holdResponses = true
        let caller = Task { try await service.getAccessTokenSilently() }
        while fake.gate == nil { await Task.yield() }
        service.clearSession()
        fake.gate?.resume()
        await #expect(throws: Auth0Service.AuthError.self) { try await caller.value }
        #expect(vault.values.isEmpty)
        #expect(!service.hasSession)
    }
}

// MARK: - Instruction versions

@Suite("Instruction list sources")
@MainActor
struct InstructionListSourceTests {
    private final class EmptyVault: TokenVault {
        func get(_ key: String) -> String? { nil }
        func set(_ value: String, for key: String) {}
        func delete(_ key: String) {}
    }

    private func version(_ number: Int) -> InstructionResponse {
        InstructionResponse(id: "I1", version: number, name: "Name", instruction: "text")
    }

    private func makeStore() -> AuthStore {
        let store = AuthStore(auth0: Auth0Service(vault: EmptyVault(), send: { _ in throw URLError(.notConnectedToInternet) }))
        store.customerInstructions = []
        return store
    }

    @Test func onboardLandingAfterTheFullListKeepsEveryVersion() {
        let store = makeStore()
        store.applyFetchedInstructions([version(3), version(2), version(1)], signedIn: true)
        store.applyOnboardInstructions([version(3)])
        #expect(store.customerInstructions.count == 3)
    }

    @Test func theFullListLandingAfterOnboardReplacesIt() {
        let store = makeStore()
        store.applyOnboardInstructions([version(3)])
        #expect(store.customerInstructions.count == 1)
        store.applyFetchedInstructions([version(3), version(2), version(1)], signedIn: true)
        #expect(store.customerInstructions.count == 3)
    }

    @Test func aListFetchedWithoutASessionDoesNotCount() {
        let store = makeStore()
        store.applyFetchedInstructions([], signedIn: false)
        store.applyOnboardInstructions([version(3)])
        #expect(store.customerInstructions.count == 1)
    }
}

@Suite("Text field width")
@MainActor
struct WebInputFieldWidthTests {
    private func fields(in view: UIView) -> [UITextField] {
        (view as? UITextField).map { [$0] } ?? view.subviews.flatMap(fields)
    }

    @Test func aLongValueStaysInsideThePadding() throws {
        let width: CGFloat = 370
        let host = UIHostingController(rootView: InputTextWithHint(
            hint: "Name",
            text: .constant(String(repeating: "Applied Electromagnetics ", count: 6))
        ).frame(width: width, height: 42))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 200))
        window.rootViewController = host
        window.isHidden = false
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()

        let field = try #require(fields(in: host.view).first)
        let right = field.convert(field.bounds, to: host.view).maxX
        #expect(right <= width - 16)
        #expect(field.clipsToBounds)
    }
}

@Suite("Tap outside ends editing")
@MainActor
struct TapOutsideEndsEditingTests {
    private func window(with views: UIView...) throws -> UIWindow {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        views.forEach(window.rootViewController!.view.addSubview)
        window.makeKeyAndVisible()
        return window
    }

    private func readOnlyText() -> UITextView {
        let text = UITextView(frame: CGRect(x: 0, y: 0, width: 300, height: 100))
        text.isEditable = false
        text.text = "Quicksort partitions in place while merge sort splits and merges."
        return text
    }

    @Test func aSelectionInReadOnlyTextOutlastsTheTapThatMadeIt() throws {
        let text = readOnlyText()
        let inside = UIView()
        text.addSubview(inside)
        let window = try window(with: text)
        defer { window.isHidden = true }

        #expect(!TapOutsideEndsEditing.keepsFocus(touched: text))
        #expect(text.becomeFirstResponder())
        #expect(TapOutsideEndsEditing.keepsFocus(touched: text))
        #expect(TapOutsideEndsEditing.keepsFocus(touched: inside))
    }

    @Test func aTapAnywhereElseStillEndsEditing() throws {
        let text = readOnlyText()
        let input = UITextView(frame: CGRect(x: 0, y: 120, width: 300, height: 40))
        let elsewhere = UIView(frame: CGRect(x: 0, y: 200, width: 300, height: 40))
        let window = try window(with: text, input, elsewhere)
        defer { window.isHidden = true }

        #expect(text.becomeFirstResponder())
        #expect(!TapOutsideEndsEditing.keepsFocus(touched: elsewhere))
        #expect(!TapOutsideEndsEditing.keepsFocus(touched: nil))

        // Typing focus, as when the composer's keyboard is up and the tap lands on a response.
        #expect(input.becomeFirstResponder())
        #expect(!TapOutsideEndsEditing.keepsFocus(touched: text))
        #expect(!TapOutsideEndsEditing.keepsFocus(touched: input))
    }

    private func markdownText(y: CGFloat = 0, reports: @escaping (String?) -> Void) -> (MarkdownUITextView, MarkdownTextView.Coordinator) {
        let text = MarkdownUITextView(frame: CGRect(x: 0, y: y, width: 300, height: 100))
        text.isEditable = false
        text.attributedText = NSAttributedString(string: "Quicksort partitions in place while merge sort splits and merges.")
        let coordinator = MarkdownTextView.Coordinator()
        coordinator.onSelectionChange = reports
        text.delegate = coordinator
        return (text, coordinator)
    }

    @Test func aTapElsewhereTakesTheAskPillWithTheSelection() throws {
        var reported: [String?] = []
        let (text, coordinator) = markdownText { reported.append($0) }
        let window = try window(with: text)
        defer { window.isHidden = true }
        _ = coordinator

        #expect(text.becomeFirstResponder())
        text.selectedRange = NSRange(location: 10, length: 10)
        #expect(reported.last == "partitions")

        window.endEditing(true)
        #expect(text.selectedRange.length == 0)
        #expect(reported.last == .some(nil))
    }

    @Test func selectingInOtherTextLeavesThePillOnTheNewSelection() throws {
        var reported: [String?] = []
        let (first, firstCoordinator) = markdownText { reported.append($0) }
        let (second, secondCoordinator) = markdownText(y: 150) { reported.append($0) }
        let window = try window(with: first, second)
        defer { window.isHidden = true }
        _ = (firstCoordinator, secondCoordinator)

        #expect(first.becomeFirstResponder())
        first.selectedRange = NSRange(location: 10, length: 10)
        #expect(second.becomeFirstResponder())
        second.selectedRange = NSRange(location: 0, length: 9)
        #expect(reported.last == "Quicksort")
    }
}


// MARK: - L1 and L2 Menu flow

@MainActor
struct MenuFlowTests {
    @Test func launchesOnTheL1Menu() {
        let router = AppRouter()
        #expect(router.isAppMenuOpen)
        #expect(!router.isMobileMenuOpen)
        #expect(!router.hasEnteredPage)
    }

    @Test func pickingAPageOpensItsL2Menu() {
        let router = AppRouter()
        router.openWithL2Menu(.memory)
        #expect(router.route == .memory)
        #expect(router.hasEnteredPage)
        #expect(!router.isAppMenuOpen)
        #expect(router.isMobileMenuOpen)
    }

    @Test func pickingTheCurrentPageKeepsItsState() {
        let router = AppRouter()
        router.navigate(.agents)
        router.agentsCategory = .memory
        router.isAppMenuOpen = true

        router.openWithL2Menu(.agents)

        #expect(router.agentsCategory == .memory)
        #expect(!router.isAppMenuOpen)
        #expect(router.isMobileMenuOpen)
    }

    @Test func goingStraightToAScreenClosesBothMenus() {
        let router = AppRouter()
        router.openWithL2Menu(.chat)
        router.isAppMenuOpen = true

        router.navigate(.instructions)

        #expect(!router.isAppMenuOpen)
        #expect(!router.isMobileMenuOpen)
    }

    @Test(arguments: [AppRouter.Route.chat, .memory, .agents, .settings(.account)])
    func hamburgerOpensTheL2MenuWherePagesHaveOne(route: AppRouter.Route) {
        let router = AppRouter()
        router.navigate(route)
        router.openPageMenu()
        #expect(router.isMobileMenuOpen)
        #expect(!router.isAppMenuOpen)
    }

    @Test(arguments: [AppRouter.Route.instructions, .instructionDetail("id"), .newAgent])
    func hamburgerOpensTheL1MenuWherePagesHaveNoL2Menu(route: AppRouter.Route) {
        let router = AppRouter()
        router.navigate(route)
        router.openPageMenu()
        #expect(router.isAppMenuOpen)
        #expect(!router.isMobileMenuOpen)
    }

    @Test func signingOutReturnsToTheLandingPage() {
        let router = AppRouter()
        router.openWithL2Menu(.settings(.account))

        router.showLanding()

        #expect(router.route == .chat)
        #expect(!router.hasEnteredPage)
        #expect(router.isAppMenuOpen)
        #expect(!router.isMobileMenuOpen)
    }

    @Test func aPageFromTheL1MenuHasItsL2MenuWaitingUnderneath() {
        let router = AppRouter()
        router.openWithL2Menu(.memory)
        #expect(router.l2MenuAppearsInPlace)
    }

    @Test func anL2MenuOpenedFromItsPageSlidesIn() {
        let router = AppRouter()
        router.openWithL2Menu(.chat)
        router.isMobileMenuOpen = false

        router.openPageMenu()

        #expect(router.isMobileMenuOpen)
        #expect(!router.l2MenuAppearsInPlace)
    }

    @Test func backToAnL2MenuWithNoL1MenuOverItSlidesIn() {
        let router = AppRouter()
        router.navigate(.privacyPolicy)

        router.openWithL2Menu(.settings(.account))

        #expect(router.isMobileMenuOpen)
        #expect(!router.l2MenuAppearsInPlace)
    }

    @Test(arguments: [
        (AppRouter.Route.chat, MenuLayer.l2), (.memoryDetail("id"), .l2), (.settings(.tools), .l2),
        (.instructions, .l1), (.instructionDetail("id"), .l1), (.newAgent, .l1), (.support, .l1),
    ])
    func anEdgeSwipeOnAPageOpensWhatItsHamburgerDoes(route: AppRouter.Route, menu: MenuLayer) {
        let router = AppRouter()
        router.navigate(route)
        #expect(router.pageMenu == menu)

        router.open(router.pageMenu)

        #expect(router.isMobileMenuOpen == (menu == .l2))
        #expect(router.isAppMenuOpen == (menu == .l1))
    }
}

// MARK: - Edge swipe

struct EdgeSwipeTests {
    @Test func releasedPastAThirdOfTheScreenItGoesThrough() {
        #expect(EdgeSwipeGesture.commits(translation: 140, velocity: 0, width: 402))
        #expect(!EdgeSwipeGesture.commits(translation: 100, velocity: 0, width: 402))
    }

    @Test func aQuickFlickGoesThroughHoweverShort() {
        #expect(EdgeSwipeGesture.commits(translation: 30, velocity: 900, width: 402))
        #expect(!EdgeSwipeGesture.commits(translation: 30, velocity: 200, width: 402))
    }

    @Test func aFlickBackTowardTheEdgeCancelsIt() {
        #expect(!EdgeSwipeGesture.commits(translation: 100, velocity: -600, width: 402))
    }

    /// Same strip as the web's EDGE_ZONE, so a swipe starts in the same place on both.
    @Test func theSwipeStartsInTheSameStripAsOnTheWeb() {
        #expect(EdgeSwipeGesture.edgeZone == 24)
    }
}

/// L2-001: a search the API couldn't run reports why, so the app can say search isn't set up.
struct SearchSetupReasonTests {
    private func error(_ status: Int, _ body: String?) -> APIError {
        APIError(status: status, message: "Request failed", body: body.map { Data($0.utf8) })
    }

    @Test func notConfiguredNamesTheMissingSetting() {
        let vectorDb = SearchSetupReason(error(409, #"{"code":"SEARCH_NOT_CONFIGURED","reason":"VECTOR_DB_NOT_CONFIGURED"}"#))
        #expect(vectorDb == .vectorDb)
        #expect(vectorDb?.settingsSection == .vectorDb)

        let embeddingKey = SearchSetupReason(error(409, #"{"code":"SEARCH_NOT_CONFIGURED","reason":"EMBEDDING_KEY_MISSING"}"#))
        #expect(embeddingKey == .embeddingKey)
        #expect(embeddingKey?.settingsSection == .embeddingKeys)
    }

    @Test func anUnknownReasonFallsBackToTheVectorDb() {
        #expect(SearchSetupReason(error(409, #"{"code":"SEARCH_NOT_CONFIGURED"}"#)) == .vectorDb)
    }

    @Test func otherFailuresAreNotSetupProblems() {
        #expect(SearchSetupReason(error(502, #"{"code":"SEARCH_UNAVAILABLE"}"#)) == nil)
        #expect(SearchSetupReason(error(409, #"{"error":"Username taken"}"#)) == nil)
        #expect(SearchSetupReason(error(409, nil)) == nil)
        #expect(SearchSetupReason(error(409, "not json")) == nil)
        #expect(SearchSetupReason(URLError(.timedOut)) == nil)
    }
}

/// Instruction search is signed-in only, on the client as on the API.
struct InstructionSearchSignInTests {
    @Test func signedOutSearchNeverCallsTheAPI() async {
        await #expect(throws: APIError.self) {
            _ = try await InstructionService.searchInstructions(token: "", query: "tax")
        }
    }
}

// MARK: - Privacy controls (DeleteDataSettings.test.tsx, LearnedFactsSettings.test.tsx)

@Suite("Delete your data")
struct DeleteDataTests {
    @Test func accountDeletionSendsTheConfirmationWord() throws {
        let body = try JSONEncoder().encode(DeleteAccountRequest())
        #expect(String(decoding: body, as: UTF8.self) == #"{"confirmation":"DELETE"}"#)
    }

    @Test func readsHowManyKeysWereDeleted() throws {
        #expect(try JSONDecoder().decode(DeleteCredentialsResponse.self, from: Data(#"{"deleted":3}"#.utf8)).deleted == 3)
        #expect(try JSONDecoder().decode(DeleteCredentialsResponse.self, from: Data("{}".utf8)).deleted == nil)
    }

    @Test func theNoticeCountsTheKeys() {
        #expect(L("settingsPage.profileSettings.deleteData.keysDeleted", ["count": 1]) == "Deleted 1 key.")
        #expect(L("settingsPage.profileSettings.deleteData.keysDeleted", ["count": 4]) == "Deleted 4 keys.")
        #expect(L("settingsPage.profileSettings.deleteData.accountConfirmPrompt", ["word": DeleteAccountRequest.confirmationWord]) == "Type DELETE to confirm")
    }

    @MainActor
    @Test func eachDeleteOpensItsOwnDialog() {
        let dialogs = SettingsDialogCenter()
        for dialog in [SettingsDialog.deleteFacts, .deleteIndex, .deleteKeys, .deleteAccount] {
            dialogs.open(dialog)
            #expect(dialogs.active == dialog)
        }
    }

    @Test func keysAndOwnDatabaseLinesOnlyForOwnKeys() {
        #expect(AccountDeletion.items(ownKeys: false).count == 2)
        #expect(AccountDeletion.items(ownKeys: true).count == 4)
    }
}

@Suite("Learned facts")
struct LearnedFactsTests {
    private typealias Section = MemorySettingsView

    @Test func everySwitchIsOnWhenTheUserNeverChangedOne() {
        for key in Section.Switch.allCases {
            #expect(Section.isOn(key, preferences: nil, pending: [:]))
            #expect(Section.isOn(key, preferences: AIConfigPreferences(), pending: [:]))
        }
    }

    @Test func thereIsNoNotesSwitchSinceNoAppSavesNotes() {
        #expect(Section.Switch.allCases == [.learnFromChats, .useInReplies])
    }

    @Test func showsTheStoredValues() {
        let preferences = AIConfigPreferences(memoryLearnFromChats: false, memoryUseInReplies: true)
        #expect(!Section.isOn(.learnFromChats, preferences: preferences, pending: [:]))
        #expect(Section.isOn(.useInReplies, preferences: preferences, pending: [:]))
    }

    @Test func aSaveInFlightShowsTheNewValue() {
        let preferences = AIConfigPreferences(memoryLearnFromChats: false)
        #expect(Section.isOn(.learnFromChats, preferences: preferences, pending: [.learnFromChats: true]))
        #expect(!Section.isOn(.useInReplies, preferences: preferences, pending: [.useInReplies: false]))
    }

    @Test func turningASwitchOffSavesOnlyThatSwitch() throws {
        let body = SaveAIConfigPreferencesRequest(aiConfigPreferences: .init(memoryUseInReplies: false))
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
        #expect(json?["aiConfigPreferences"] as? [String: Bool] == ["memoryUseInReplies": false])
    }

    @Test func readsTheStoredSwitches() throws {
        let stored = Data(#"{"memoryLearnFromChats":false,"memoryUseInReplies":true}"#.utf8)
        let preferences = try JSONDecoder().decode(AIConfigPreferences.self, from: stored)
        #expect(preferences.memoryLearnFromChats == false)
        #expect(preferences.memoryUseInReplies == true)
        #expect(preferences.memoryLearnFromNotes == nil)
    }

    @Test func theToastCountsTheFacts() {
        #expect(L("settingsPage.learnedFacts.deletedToast", ["count": 1]) == "Deleted 1 learned fact.")
        #expect(L("settingsPage.learnedFacts.deletedToast", ["count": 12]) == "Deleted 12 learned facts.")
    }
}

// MARK: - Detail pages (documents/Projects/MemoryPageRedesign)

@Suite("Detail pages")
@MainActor
struct DetailPageTests {
    private func show(_ before: String, _ after: String) -> String {
        WordDiff.diff(before, after).map { part in
            switch part.kind {
            case .same: return part.text
            case .ins: return "+[\(part.text)]"
            case .del: return "-[\(part.text)]"
            }
        }.joined()
    }

    @Test func wordDiffMarksWordsWithPunctuationApart() {
        #expect(show("Prefers concise answers.", "Prefers concise answers with the conclusion first.")
            == "Prefers concise answers +[with the conclusion first].")
        #expect(show("Prefers short answers.", "Prefers concise answers.") == "Prefers -[short]+[concise] answers.")
        #expect(WordDiff.diff("a c", "a b c").first { $0.kind == .ins }?.text == "b")
        #expect(WordDiff.diff("", "new") == [DiffPart(text: "new", kind: .ins)])
    }

    @Test func longUnchangedRunsAreShortened() {
        let same = (0..<40).map { "w\($0)" }.joined(separator: " ")
        let condensed = WordDiff.condense(WordDiff.diff("\(same) old \(same)", "\(same) new \(same)"))
        #expect(condensed.map(\.text).joined().contains("…"))
    }

    @Test func instructionHistoryComparesEachVersionWithTheOneBefore() {
        let v1 = InstructionResponse(id: "I", version: 1, name: "VC", instruction: "You are a VC.", createdAt: "2026-09-03T09:41:00Z")
        let v2 = InstructionResponse(id: "I", version: 2, name: "AI VC", instruction: "You are a VC. Be critical.", createdAt: "2026-10-28T14:10:00Z")
        var viewed: Int?
        let entries = InstructionLabels.history([v2, v1]) { viewed = $0 }

        #expect(entries.map(\.title) == ["Edited", "Created"])
        #expect(entries[0].current && entries[0].view == nil)
        #expect(entries[0].facts.map(\.label) == ["Name", "Change"])
        #expect(entries[1].facts.map(\.label) == ["Text"])
        entries[1].view?.action()
        #expect(viewed == 1)
    }

    @Test func onlyCoreInProfileAppliesToEveryConversation() {
        let store = MemoriesStore()
        store.projects = [Project(projectId: "PRJ1", name: "Market research")]
        #expect(MemoryLabels.applies(MemoryPlacement(projectId: nil, kind: .core), store: store) == "Every conversation · Core")
        #expect(MemoryLabels.applies(MemoryPlacement(projectId: nil, kind: .episodic), store: store) == "When relevant · Episodic")
        #expect(MemoryLabels.applies(MemoryPlacement(projectId: "PRJ1", kind: .episodic), store: store) == "Market research · Episodic")
    }

    @Test func repliesFromBeforeTheUsageLogAreCountedNotHidden() {
        var memory = CustomerMemory(memoryId: "MEM#old", text: "Runs a studio.", kind: .core)
        memory.hitCount = 12
        #expect(MemoryLabels.usageSummary(memory) == "12 replies")
        #expect(MemoryLabels.unlistedReplies(memory, listed: 3, complete: true) == 9)
        #expect(MemoryLabels.unlistedReplies(memory, listed: 3, complete: false) == 0)
        memory.hitCount = 0
        #expect(MemoryLabels.usageSummary(memory) == "Not used in a reply yet")
    }

    @Test func detailCardsIndentListsInsideTheTextColumn() throws {
        func headIndent(of word: String, listIndent: CGFloat) throws -> CGFloat {
            let segments = MarkdownParser.segments(for: "Intro\n\n1. One\n2. Two", options: MarkdownParser.Options(listIndent: listIndent))
            for case .text(_, let text, _, _) in segments {
                let range = (text.string as NSString).range(of: word)
                guard range.location != NSNotFound else { continue }
                return try #require(text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle).headIndent
            }
            Issue.record("\(word) not rendered")
            return -1
        }
        #expect(try headIndent(of: "One", listIndent: 24) == MarkdownParser.hangingInset + 24)
        #expect(try headIndent(of: "Intro", listIndent: 24) == MarkdownParser.hangingInset)
        #expect(try headIndent(of: "One", listIndent: 0) == MarkdownParser.hangingInset)
    }

    @Test func memoryUsageIsOneItemPerConversationNewestFirst() {
        let items = MemoryLabels.usageByConversation([
            MemoryUsage(conversationId: "C1", messageId: "m2", usedAt: "2026-11-06T10:00:00Z", how: "core", conversationTitle: "Weekly", conversationAvailable: true),
            MemoryUsage(conversationId: "C1", messageId: "m1", usedAt: "2026-11-05T10:00:00Z", how: "core", conversationTitle: "Weekly", conversationAvailable: true),
            MemoryUsage(conversationId: "GONE", messageId: "m0", usedAt: "2026-11-01T10:00:00Z", how: "core", conversationTitle: nil, conversationAvailable: false),
        ])

        #expect(items.map(\.id) == ["C1", "GONE"])
        #expect(items[0].meta?.hasPrefix("2 replies · last") == true)
        #expect(items[1].available == false)
    }

    @Test func childPagesBelongToTheirSection() {
        let router = AppRouter()
        for route: AppRouter.Route in [.memoryEdit("M"), .memoryHistory("M"), .memoryUsage("M"), .memoryDetail("M", version: 2)] {
            router.navigate(route)
            #expect(router.activeNavItem == "Memory")
        }
        for route: AppRouter.Route in [.instructionEdit(nil), .instructionHistory("I"), .instructionUsage("I"), .instructionDetail("I", version: 1)] {
            router.navigate(route)
            #expect(router.activeNavItem == "Instructions")
        }
    }
}

// MARK: - Leaving a conversation

@MainActor
struct LeavingConversationTests {
    private final class Cancels { var ids: [String] = [] }

    /// A store with one reply streaming: its request is open and the server has answered.
    private func streamingStore(_ cancels: Cancels) -> (ConversationStore, Task<Void, Error>) {
        let store = ConversationStore()
        store.cancelOnServer = { ids in cancels.ids += ids }
        let task = Task<Void, Error> { try await Task.sleep(nanoseconds: 60_000_000_000) }
        store.streamTasks["b1-OPENAI"] = task
        store.generationIds["b1-OPENAI"] = "gen-1"
        store.headersReceived.insert("b1-OPENAI")
        return (store, task)
    }

    @Test func newChatDropsTheStreamWithoutCancellingTheReply() async {
        let cancels = Cancels()
        let (store, task) = streamingStore(cancels)
        store.resetConversation()
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(task.isCancelled)
        #expect(cancels.ids.isEmpty)
    }

    @Test func aRequestStillWaitingForItsHeadersStaysOpen() async {
        let cancels = Cancels()
        let (store, task) = streamingStore(cancels)
        store.headersReceived.remove("b1-OPENAI")
        store.resetConversation()
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(!task.isCancelled)
        #expect(cancels.ids.isEmpty)
        task.cancel()
    }

    @Test func stopStillCancelsTheReplyOnTheServer() async {
        let cancels = Cancels()
        let (store, task) = streamingStore(cancels)
        store.stopGenerating()
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(task.isCancelled)
        #expect(cancels.ids == ["gen-1"])
    }
}

// MARK: - Resuming a reply

@MainActor
struct ReplyResumeFrameTests {
    private final class Seen {
        var runs: [(String, Int?)] = []
        var seqs: [Int] = []
        var deltas: [String] = []
    }

    private func feed(_ lines: [String]) throws -> Seen {
        let seen = Seen()
        let cb = StreamCallbacks(
            onDelta: { seen.deltas.append($0) },
            onRun: { seen.runs.append(($0, $1)) },
            onSeq: { seen.seqs.append($0) }
        )
        for line in lines { _ = try GenerateTextStreamService.processLine(line, cb) }
        return seen
    }

    @Test func theRunFrameNamesTheRunAndItsClock() throws {
        let seen = try feed([#"{"t":"run","v":"run_1","s":4,"ms":41250}"#])
        #expect(seen.runs.count == 1)
        #expect(seen.runs.first?.0 == "run_1")
        #expect(seen.runs.first?.1 == 41250)
        #expect(seen.seqs == [4])
    }

    @Test func eachFrameCommitsItsSeqAfterItIsApplied() throws {
        let seen = try feed([#"{"t":"c","v":"Hel","s":5}"#, #"{"t":"c","v":"lo","s":6}"#, #"{"t":"done","status":"ok","s":6}"#])
        #expect(seen.deltas == ["Hel", "lo"])
        #expect(seen.seqs == [5, 6, 6])
    }

    @Test func framesWithoutASeqLeaveItAlone() throws {
        let seen = try feed([#"{"t":"c","v":"x"}"#, #"{"t":"done","status":"ok"}"#])
        #expect(seen.seqs.isEmpty)
    }

    @Test func anErrorFrameDoesNotCommitItsSeq() {
        let seen = Seen()
        let cb = StreamCallbacks(onDelta: { _ in }, onSeq: { seen.seqs.append($0) })
        #expect(throws: StreamGenerationError.self) { try GenerateTextStreamService.processLine(#"{"t":"err","v":"quota","s":9}"#, cb) }
        #expect(seen.seqs.isEmpty)
    }

    @Test func theTurnClockRunsOnFromWhenItArrived() {
        let received = Date(timeIntervalSince1970: 1_000)
        let clock = RunClock(at: 41_250, receivedAt: received)
        #expect(clock.now(received.addingTimeInterval(2.5)) == 43_750)
    }
}

// MARK: - Unread replies

@MainActor
struct UnreadReplyTests {
    @Test func theListSaysWhichChatsHaveAnUnreadReply() throws {
        let json = #"{"conversations":[{"conversationId":"c1","title":"A","unread":true},{"conversationId":"c2","title":"B"}]}"#
        let page = try JSONDecoder().decode(GetCustomerConversationsResponse.self, from: Data(json.utf8))
        #expect(page.conversations[0].unread == true)
        #expect(page.conversations[1].unread == nil)
    }

    @Test func openingAChatClearsItsDotEverywhereItIsListed() {
        let history = HistoryStore()
        history.items = [ConversationSummary(conversationId: "c1", unread: true), ConversationSummary(conversationId: "c2", unread: true)]
        history.pinned = [ConversationSummary(conversationId: "c1", unread: true)]
        history.projectItems = ["PRJ1": [ConversationSummary(conversationId: "c1", projectId: "PRJ1", unread: true)]]

        history.markRead(id: "c1")

        #expect(history.items.first { $0.conversationId == "c1" }?.unread == false)
        #expect(history.pinned.first?.unread == false)
        #expect(history.projectItems["PRJ1"]?.first?.unread == false)
        #expect(history.items.first { $0.conversationId == "c2" }?.unread == true)
    }
}
