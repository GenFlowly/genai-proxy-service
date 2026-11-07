import Foundation
import SwiftData

/// Owns the SwiftData stack. All on-device cache (history, notes, instructions,
/// catalogs, drafts, preferences) persists here, so lists paint instantly on launch
/// and read offline; every `@Model` type must be listed in `models`.
@MainActor
final class CacheStore {
    static let shared: CacheStore = {
        do { return try CacheStore() }
        catch { fatalError("CacheStore: failed to create ModelContainer — \(error)") }
    }()

    let container: ModelContainer
    var context: ModelContext { container.mainContext }

    static let models: [any PersistentModel.Type] = [
        CacheEntry.self
    ]

    /// `inMemory` is used by unit tests so they never touch the on-disk store.
    init(inMemory: Bool = false) throws {
        let schema = Schema(CacheStore.models)
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: inMemory)
        self.container = try ModelContainer(for: schema, configurations: [configuration])
    }

    func save() {
        guard context.hasChanges else { return }
        do { try context.save() }
        catch { AppObservability.capture(error, context: ["where": "CacheStore.save"]) }
    }

    // MARK: - Key/value

    private func entry(_ key: String) -> CacheEntry? {
        var descriptor = FetchDescriptor<CacheEntry>(predicate: #Predicate { $0.key == key })
        descriptor.fetchLimit = 1
        return try? context.fetch(descriptor).first
    }

    func read<T: Decodable>(_ type: T.Type = T.self, key: String) -> T? {
        guard let entry = entry(key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: entry.data)
    }

    func readEnvelope<T: Decodable>(_ type: T.Type = T.self, key: String) -> (value: T, version: Int?)? {
        guard let entry = entry(key), let value = try? JSONDecoder().decode(T.self, from: entry.data) else { return nil }
        return (value, entry.version)
    }

    func write(_ value: some Encodable, key: String, version: Int? = nil) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        if let existing = entry(key) {
            existing.data = data
            existing.version = version
            existing.updatedAt = Date()
        } else {
            context.insert(CacheEntry(key: key, data: data, version: version))
        }
        save()
    }

    func readString(_ key: String) -> String? {
        read(String.self, key: key)
    }

    func writeString(_ value: String?, key: String) {
        if let value { write(value, key: key) } else { remove(key) }
    }

    func remove(_ key: String) {
        if let existing = entry(key) {
            context.delete(existing)
            save()
        }
    }

    func removeAll(withPrefix prefix: String) {
        let matches = (try? context.fetch(FetchDescriptor<CacheEntry>(predicate: #Predicate { $0.key.starts(with: prefix) }))) ?? []
        matches.forEach { context.delete($0) }
        save()
    }

    /// Full wipe — used by logout teardown so no customer data survives sign-out.
    func deleteAll() {
        for model in CacheStore.models {
            try? context.delete(model: model)
        }
        save()
    }
}

/// Older builds cached account data in UserDefaults, which only logout cleared. It lives in
/// SwiftData now, so an upgraded install shouldn't keep those copies on disk.
enum LegacyDefaults {
    private static let globalKeys: Set<String> = [StorageSuffix.customerIdGlobal]
    private static let customerKeySuffixes = [
        "_ai_preferences", "_ai_vendor_models", "_instructions", "_selected_agent_id",
        "_selected_instruction_id", "_system_prompt", "_vendor_api_key_statuses"
    ]

    static func removeStaleValues(from defaults: UserDefaults = .standard) {
        for key in defaults.dictionaryRepresentation().keys
        where globalKeys.contains(key) || customerKeySuffixes.contains(where: key.hasSuffix) {
            defaults.removeObject(forKey: key)
        }
    }
}

/// Everything the app keeps on this device for a signed-in user. Mirrors the web's
/// `localStorage.clear()` + `queryClient.clear()`. Theme is the one survivor: it's a device
/// display preference (storageKeys.ts).
enum LocalSessionData {
    static func wipe(
        defaults: UserDefaults = .standard,
        domain: String? = Bundle.main.bundleIdentifier,
        temporaryDirectory: URL = FileManager.default.temporaryDirectory
    ) {
        let theme = defaults.string(forKey: "theme")
        if let domain { defaults.removePersistentDomain(forName: domain) }
        if let theme { defaults.set(theme, forKey: "theme") }

        CacheStore.shared.deleteAll()

        // `AsyncImage` keeps images here, attachments among them.
        URLCache.shared.removeAllCachedResponses()
        HTTPCookieStorage.shared.removeCookies(since: .distantPast)

        MarkdownParser.clearCache()
        MathRenderer.clearCache()

        // Files from the pickers.
        let fileManager = FileManager.default
        for file in (try? fileManager.contentsOfDirectory(at: temporaryDirectory, includingPropertiesForKeys: nil)) ?? [] {
            try? fileManager.removeItem(at: file)
        }
    }
}

