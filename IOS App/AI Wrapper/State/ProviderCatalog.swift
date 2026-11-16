import Foundation
import Combine

// Mirrors genai-proxy-server models/api/ProviderCatalog.kt

struct ProviderModelInfo: Codable, Equatable, Hashable {
    var name: String
    /// False = agentic features (tools) may degrade on this model.
    var supportsTools: Bool?
}

struct ProviderInfo: Codable, Equatable, Identifiable, Hashable {
    /// Canonical provider id (LiteLLM id; legacy vendors map server-side).
    var id: String
    var displayName: String
    /// True = first-party langchain integration; false = LiteLLM path.
    var native: Bool?
    var models: [ProviderModelInfo]
}

struct ProviderCatalogResponse: Codable, Equatable {
    var providers: [ProviderInfo]
}

/// BYOK provider catalog (GET /api/v1/providers) — static per backend deploy, so one
/// fetch per session; the previous session's copy paints until it lands
/// (useProviderCatalog.ts). The single source of truth for vendor naming.
@MainActor
final class ProviderCatalog: ObservableObject {
    static let shared = ProviderCatalog()

    @Published private(set) var providers: [ProviderInfo] = []
    /// Moves on at logout, so a catalog still in flight can't land afterwards.
    private var generation = 0
    private var didFetch = false

    /// The legacy three vendors are stored by their uppercase enum names; every other
    /// provider under its lowercase catalog id (backend AIVendor.kt).
    private static let legacyByCatalogId = ["openai": "OPENAI", "anthropic": "CLAUDE", "gemini": "GEMINI"]

    static func storedVendorId(catalogId: String) -> String {
        legacyByCatalogId[catalogId] ?? catalogId
    }

    static func catalogId(forStored stored: String) -> String {
        legacyByCatalogId.first { $0.value == stored }?.key ?? stored
    }

    /// Title-cased catalog id, the catalog's own fallback rule.
    static func fallbackDisplayName(_ vendorId: String) -> String {
        catalogId(forStored: vendorId)
            .replacingOccurrences(of: "_", with: " ")
            .capitalized(with: Locale(identifier: "en_US"))
    }

    func displayName(for vendorId: String) -> String {
        let id = Self.catalogId(forStored: vendorId)
        return providers.first { $0.id == id }?.displayName ?? Self.fallbackDisplayName(vendorId)
    }

    func paintFromCache() {
        guard providers.isEmpty, let cached = CacheStore.shared.read(ProviderCatalogResponse.self, key: StorageSuffix.providerCatalogGlobal) else { return }
        providers = cached.providers
    }

    func load(token: String) async {
        paintFromCache()
        guard !didFetch else { return }
        didFetch = true
        let session = generation
        guard let response = try? await APIClient.requestJSON(Endpoints.getProviders, token: token, as: ProviderCatalogResponse.self) else {
            didFetch = false
            return
        }
        guard session == generation else { return }
        providers = response.providers
        if !response.providers.isEmpty {
            CacheStore.shared.write(response, key: StorageSuffix.providerCatalogGlobal)
        }
    }

    func reset() {
        generation += 1
        providers = []
        didFetch = false
    }
}
