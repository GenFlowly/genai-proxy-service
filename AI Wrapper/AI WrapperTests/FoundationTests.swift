import Testing
import Foundation
import SwiftData
@testable import AI_Wrapper

struct ConfigReaderTests {
    @Test func requiredStringThrowsWhenMissing() {
        let reader = ConfigReader(dictionary: [:])
        #expect(throws: ConfigReader.ConfigError.self) { try reader.requiredString("API_BASE_URL") }
    }

    @Test func requiredStringThrowsWhenBlank() {
        let reader = ConfigReader(dictionary: ["K": "   "])
        #expect(throws: ConfigReader.ConfigError.self) { try reader.requiredString("K") }
    }

    @Test func requiredStringReturnsTrimmed() throws {
        let reader = ConfigReader(dictionary: ["K": "  hello  "])
        #expect(try reader.requiredString("K") == "hello")
    }

    @Test func requiredURLThrowsOnSchemeless() {
        let reader = ConfigReader(dictionary: ["U": "localhost:8080"])
        #expect(throws: ConfigReader.ConfigError.self) { try reader.requiredURL("U") }
    }

    @Test func requiredURLParsesValid() throws {
        let reader = ConfigReader(dictionary: ["U": "http://localhost:8080"])
        #expect(try reader.requiredURL("U").absoluteString == "http://localhost:8080")
    }

    @Test func optionalStringNilWhenBlank() {
        #expect(ConfigReader(dictionary: ["S": "  "]).optionalString("S") == nil)
        #expect(ConfigReader(dictionary: ["S": "x"]).optionalString("S") == "x")
    }

    /// AppConfig reads the real app Info.plist (app-hosted test), whichever stage this build
    /// uses. Catches a stage value that didn't reach the app: `//` in an xcconfig truncates a
    /// URL, and an undefined key stays blank or as a literal `$(KEY)`.
    @Test func everyConfigValueResolves() throws {
        for url in [AppConfig.backendBaseURL, AppConfig.webAppURL, AppConfig.encodeAPIURL, AppConfig.supportRequestURL] {
            #expect(url.host?.isEmpty == false, "\(url)")
            #expect(!url.absoluteString.contains("$("), "\(url)")
        }
        for value in [AppConfig.Auth0.domain, AppConfig.Auth0.clientId, AppConfig.Auth0.audience] {
            #expect(!value.isEmpty)
            #expect(!value.contains("$("), "\(value)")
        }
        #expect(AppEnvironment(rawValue: try AppConfig.reader.requiredString("APP_ENV")) != nil)
        let displayName = try #require(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        #expect(!displayName.isEmpty)
        #expect(!displayName.contains("$("), "\(displayName)")
    }

    /// A key added to one stage but not the others would only fail once someone switched to it.
    @Test func everyStageDefinesTheSameKeys() throws {
        let folder = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("BuildSettings/Environments")
        let stages = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "xcconfig" }
        #expect(stages.count > 1)
        let keys = try stages.map { stage in
            Set(try String(contentsOf: stage, encoding: .utf8)
                .split(separator: "\n")
                .filter { !$0.hasPrefix("//") && $0.contains("=") }
                .map { String($0.prefix { $0 != " " && $0 != "=" }) })
        }
        #expect(Set(keys).count == 1)
    }
}

struct LocalizationTests {
    /// Proves the en.lproj string table is bundled and reachable via L().
    @Test func localizedKeyResolves() {
        #expect(L("test.smoke") == "localized-ok")
    }
}

@MainActor
struct CacheStoreTests {
    @Test func valueRoundTrips() throws {
        let store = try CacheStore(inMemory: true)
        store.write(["a", "b"], key: "c1_list", version: 7)
        let envelope = store.readEnvelope([String].self, key: "c1_list")
        #expect(envelope?.value == ["a", "b"])
        #expect(envelope?.version == 7)
        store.write(["c"], key: "c1_list")
        #expect(store.read([String].self, key: "c1_list") == ["c"])
    }

    @Test func prefixRemovalOnlyTouchesMatchingKeys() throws {
        let store = try CacheStore(inMemory: true)
        store.writeString("draft", key: "c1_prompt_editor_content_x")
        store.writeString("keep", key: "c1_system_prompt")
        store.removeAll(withPrefix: "c1_prompt_editor_content_")
        #expect(store.readString("c1_prompt_editor_content_x") == nil)
        #expect(store.readString("c1_system_prompt") == "keep")
    }

    @Test func deleteAllClearsStore() throws {
        let store = try CacheStore(inMemory: true)
        store.writeString("x", key: "c2")
        store.deleteAll()
        #expect(store.readString("c2") == nil)
    }
}
