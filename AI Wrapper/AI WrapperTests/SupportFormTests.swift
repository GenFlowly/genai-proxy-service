import Foundation
import Testing
@testable import AI_Wrapper

struct SupportFormTests {
    private var valid: SupportForm {
        SupportForm(name: "  Ada  ", email: " ada@example.com ", topic: .bug, message: "  The app closes on launch.  ")
    }

    @Test func aCompleteFormCanSend() {
        #expect(valid.canSend)
    }

    @Test(arguments: ["", "ada", "ada@example", "a b@example.com", "ada@@example.com"])
    func anAddressWeCantReplyToBlocksSending(email: String) {
        var form = valid
        form.email = email
        #expect(!form.isEmailValid)
        #expect(!form.canSend)
    }

    @Test func aTopicIsRequired() {
        var form = valid
        form.topic = nil
        #expect(!form.canSend)
    }

    @Test func aMessageNeedsTenCharactersOnceTrimmed() {
        var form = valid
        form.message = "   123456789   "
        #expect(!form.isMessageValid)
        form.message = "1234567890"
        #expect(form.isMessageValid)
    }

    @Test func theMessageLimitCountsCodePointsAsTheLambdaDoes() {
        var form = valid
        form.message = String(repeating: "🇺🇸", count: 2501)
        #expect(form.message.count == 2501)
        #expect(!form.isMessageValid)
    }

    @Test func clippingNeverGoesPastTheLimit() {
        #expect(SupportForm.clip("short", to: 10) == "short")
        #expect(SupportForm.clip("🇺🇸🇺🇸", to: 3).unicodeScalars.count == 3)
    }

    @Test func theRequestIsTrimmedAndTaggedWithTheApp() throws {
        let data = try JSONEncoder().encode(try #require(valid.request(appVersion: "1.0.1 (7)", customerId: "CUABC123")))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["name"] as? String == "Ada")
        #expect(json["email"] as? String == "ada@example.com")
        #expect(json["topic"] as? String == "bug")
        #expect(json["message"] as? String == "The app closes on launch.")
        let context = try #require(json["context"] as? [String: Any])
        #expect(context["source"] as? String == "ios")
        #expect(context["appVersion"] as? String == "1.0.1 (7)")
        #expect(context["customerId"] as? String == "CUABC123")
    }

    @Test func unknownContextIsLeftOut() throws {
        let data = try JSONEncoder().encode(try #require(valid.request(appVersion: nil, customerId: nil)))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["context"] as? [String: String] == ["source": "ios"])
    }

    @Test func anIncompleteFormBuildsNoRequest() {
        #expect(SupportForm().request(appVersion: nil, customerId: nil) == nil)
    }

    /// The Lambda rejects any other value.
    @Test func topicsAreTheOnesTheLambdaAccepts() {
        #expect(SupportTopic.allCases.map(\.rawValue) == ["account", "billing", "bug", "feature", "privacy", "other"])
    }

    @Test(arguments: SupportTopic.allCases)
    func everyTopicHasALabel(topic: SupportTopic) {
        #expect(topic.label != "supportPage.topics.\(topic.rawValue)")
    }

    @Test func versionTextUsesWhateverTheBundleHas() {
        #expect(SupportForm.appVersion(info: ["CFBundleShortVersionString": "1.2", "CFBundleVersion": "40"]) == "1.2 (40)")
        #expect(SupportForm.appVersion(info: ["CFBundleShortVersionString": "1.2"]) == "1.2")
        #expect(SupportForm.appVersion(info: ["CFBundleVersion": "40"]) == "(40)")
        #expect(SupportForm.appVersion(info: ["CFBundleShortVersionString": "", "CFBundleVersion": ""]) == nil)
        #expect(SupportForm.appVersion(info: [:]) == nil)
    }

    @Test func taggedWordsBecomeTheLink() throws {
        let url = try #require(URL(string: "mailto:help@example.com"))
        let text = SupportForm.linked("Try again, or email <mail>help@example.com</mail>.", tag: "mail", to: url)
        #expect(String(text.characters) == "Try again, or email help@example.com.")
        #expect(text.runs.filter { $0.link != nil }.map { String(text[$0.range].characters) } == ["help@example.com"])
    }

    @Test func textWithoutTheTagStaysPlain() throws {
        let text = SupportForm.linked("No link here.", tag: "mail", to: try #require(URL(string: "mailto:a@b.co")))
        #expect(String(text.characters) == "No link here.")
        #expect(text.runs.allSatisfy { $0.link == nil })
    }
}
