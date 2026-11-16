import Foundation

// MARK: - Support (src/services/supportService.ts)

enum SupportTopic: String, CaseIterable, Encodable {
    case account, billing, bug, feature, privacy, other

    var label: String { L("supportPage.topics.\(rawValue)") }
}

struct SupportRequest: Encodable {
    struct Context: Encodable {
        var source = "ios"
        var appVersion: String?
        var customerId: String?
    }

    let name: String
    let email: String
    let topic: SupportTopic
    let message: String
    let context: Context
}

enum SupportService {
    /// Never retried: a second attempt would email the support inbox twice.
    static func send(token: String, request: SupportRequest) async throws {
        _ = try await APIClient.request(AppConfig.supportRequestURL, method: .post, token: token, body: request, retries: 0)
    }
}
