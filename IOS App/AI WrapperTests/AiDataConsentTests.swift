import Foundation
import Testing
@testable import AI_Wrapper

struct AiDataConsentTests {
    private static let keys = [
        "title", "intro", "modelsTitle", "modelsBody", "memoryTitle", "memoryBody",
        "webTitle", "webBody", "note",
    ]

    /// Vendors can change on the backend without an app release, so the screen never names one.
    @Test func theScreenNamesNoVendor() {
        let pattern = /(?i)openai|anthropic|claude|gemini|google|xai|grok|voyage|zilliz|milvus|tavily/
        for key in Self.keys {
            let text = L("aiDataConsent.\(key)")
            #expect(text != "aiDataConsent.\(key)", "missing string \(key)")
            #expect(text.firstMatch(of: pattern) == nil, "\(key): \(text)")
        }
    }

    @Test func anOlderBackendDoesNotAsk() throws {
        let data = Data(#"{"customerId":"CU1"}"#.utf8)
        let response = try JSONDecoder().decode(OnboardCustomerResponse.self, from: data)
        #expect(response.aiDataConsentRequired == nil)
        #expect(response.aiDataConsentAt == nil)
    }

    @Test func theRequiredFlagAndDateDecode() throws {
        let data = Data(#"{"aiDataConsentRequired":true,"aiDataConsentAt":"2026-11-08T21:00:00Z"}"#.utf8)
        let response = try JSONDecoder().decode(OnboardCustomerResponse.self, from: data)
        #expect(response.aiDataConsentRequired == true)
        #expect(response.aiDataConsentAt == "2026-11-08T21:00:00Z")
    }

    @Test func theDateIsShownOnTheDevicesCalendar() throws {
        let utcZone = try #require(TimeZone(identifier: "UTC"))
        let seattleZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let utc = try #require(AiDataConsentDate.display("2026-11-09T02:00:00Z", timeZone: utcZone))
        let seattle = try #require(AiDataConsentDate.display("2026-11-09T02:00:00Z", timeZone: seattleZone))
        #expect(utc.contains("9"))
        #expect(seattle.contains("8"))
    }

    @Test func fractionalSecondsParse() {
        #expect(AiDataConsentDate.display("2026-11-08T21:00:00.123456Z") != nil)
    }

    @Test func noDateShowsNothing() {
        #expect(AiDataConsentDate.display(nil) == nil)
        #expect(AiDataConsentDate.display("not a date") == nil)
    }
}
