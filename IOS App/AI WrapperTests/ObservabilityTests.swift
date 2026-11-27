import Testing
import Foundation
#if canImport(Sentry)
import Sentry
#endif
@testable import AI_Wrapper

@MainActor
struct ReplyTimingTests {
    private final class RecordingReply: ReplyTiming {
        var firstTokens = 0
        var finishes: [Error?] = []
        func firstToken() { firstTokens += 1 }
        func finish(error: Error?) { finishes.append(error) }
    }

    private final class RecordingReporter: ErrorReporter {
        let reply = RecordingReply()
        var started: [(vendor: String, model: String)] = []
        func capture(_ error: Error, context: [String: String]) {}
        func captureMessage(_ message: String) {}
        func startReply(vendor: String, model: String) -> ReplyTiming {
            started.append((vendor, model))
            return reply
        }
    }

    private struct Failure: Error {}

    private let aiConfig = AIConfig(aiVendor: .openai, model: "gpt-5.4-nano")

    @Test func startsTaggedWithTheVendorAndModelAndFinishesOK() async throws {
        let reporter = RecordingReporter()
        let result = try await AppObservability.timeReply(aiConfig, reporter: reporter) { reply in
            reply.firstToken()
            return "done"
        }
        #expect(result == "done")
        #expect(reporter.started.map(\.vendor) == ["OPENAI"])
        #expect(reporter.started.map(\.model) == ["gpt-5.4-nano"])
        #expect(reporter.reply.firstTokens == 1)
        #expect(reporter.reply.finishes.count == 1)
        #expect(reporter.reply.finishes.first! == nil)
    }

    @Test func finishesWithTheErrorAndRethrowsIt() async {
        let reporter = RecordingReporter()
        await #expect(throws: Failure.self) {
            try await AppObservability.timeReply(aiConfig, reporter: reporter) { _ in throw Failure() }
        }
        #expect(reporter.reply.finishes.count == 1)
        #expect(reporter.reply.finishes.first! is Failure)
    }

    @Test func reportersWithoutTimingIgnoreTheReply() {
        let reply = LoggingErrorReporter().startReply(vendor: "OPENAI", model: "gpt-5.4-nano")
        #expect(reply is UntimedReply)
    }
}

#if canImport(Sentry)
struct SentryScrubbingTests {
    @Test func breadcrumbsLoseTheQueryAndKeepTheRest() throws {
        let breadcrumb = Breadcrumb(level: .info, category: "http")
        breadcrumb.setData(value: "https://api.genflowly.com/api/search", key: "url")
        breadcrumb.setData(value: "q=private%20words&types=chat", key: "http.query")
        breadcrumb.setData(value: "top", key: "http.fragment")
        let scrubbed = try #require(SentryScrubbing.breadcrumb(breadcrumb))
        #expect(scrubbed.data?["url"] as? String == "https://api.genflowly.com/api/search")
        #expect(scrubbed.data?["http.query"] == nil)
        #expect(scrubbed.data?["http.fragment"] == nil)
    }

    @Test func failedRequestEventsLoseTheQuery() throws {
        let event = Event(level: .error)
        let request = SentryRequest()
        request.url = "https://api.genflowly.com/api/search"
        request.queryString = "q=private%20words"
        request.fragment = "top"
        event.request = request
        let scrubbed = try #require(SentryScrubbing.event(event))
        #expect(scrubbed.request?.url == "https://api.genflowly.com/api/search")
        #expect(scrubbed.request?.queryString == nil)
        #expect(scrubbed.request?.fragment == nil)
    }
}
#endif
