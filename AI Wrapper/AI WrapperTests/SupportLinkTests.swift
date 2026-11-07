import Foundation
import Testing
@testable import AI_Wrapper

struct SupportLinkTests {
    @Test func opensTheWebSupportPageTaggedWithTheAppAndItsVersion() throws {
        let url = SupportLink.url(
            webAppURL: try #require(URL(string: "https://genflowly.com")),
            info: ["CFBundleShortVersionString": "1.0", "CFBundleVersion": "12"]
        )
        #expect(url.absoluteString == "https://genflowly.com/support?source=ios&appVersion=1.0%20(12)")
    }

    @Test func aTrailingSlashOnTheWebAppURLDoesNotDoubleUp() throws {
        let url = SupportLink.url(webAppURL: try #require(URL(string: "http://localhost:3000/")), info: [:])
        #expect(url.absoluteString == "http://localhost:3000/support?source=ios")
    }

    @Test func versionTextUsesWhateverTheBundleHas() {
        #expect(SupportLink.appVersion(info: ["CFBundleShortVersionString": "1.2", "CFBundleVersion": "40"]) == "1.2 (40)")
        #expect(SupportLink.appVersion(info: ["CFBundleShortVersionString": "1.2"]) == "1.2")
        #expect(SupportLink.appVersion(info: ["CFBundleVersion": "40"]) == "(40)")
        #expect(SupportLink.appVersion(info: ["CFBundleShortVersionString": "", "CFBundleVersion": ""]) == nil)
        #expect(SupportLink.appVersion(info: [:]) == nil)
    }

    @Test func theRealBuildPointsAtItsOwnStage() {
        let url = SupportLink.url()
        #expect(url.host == AppConfig.webAppURL.host)
        #expect(url.path.hasSuffix("/support"))
        #expect(url.query?.contains("source=ios") == true)
    }
}
