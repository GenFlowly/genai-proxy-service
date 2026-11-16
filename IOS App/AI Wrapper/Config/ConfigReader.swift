import Foundation

/// Testable reader for build-time configuration (the per-config Info.plist).
/// Separated from `AppConfig` so the missing/invalid-key behavior can be unit
/// tested without crashing the process (AppConfig turns these errors into a
/// fail-fast `fatalError` for app use).
struct ConfigReader {
    enum ConfigError: Error, CustomStringConvertible, Equatable {
        case missing(String)
        case invalidURL(key: String, value: String)

        var description: String {
            switch self {
            case .missing(let key):
                return "missing/blank config key '\(key)' — check BuildSettings/Info-*.plist"
            case .invalidURL(let key, let value):
                return "config key '\(key)' is not a valid URL: '\(value)'"
            }
        }
    }

    private let lookup: (String) -> Any?

    init(bundle: Bundle) { self.lookup = { bundle.object(forInfoDictionaryKey: $0) } }
    init(dictionary: [String: Any]) { self.lookup = { dictionary[$0] } }

    /// Required non-blank string. Throws `.missing` if absent or blank.
    func requiredString(_ key: String) throws -> String {
        guard let raw = lookup(key) as? String else { throw ConfigError.missing(key) }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ConfigError.missing(key) }
        return trimmed
    }

    /// Optional string — `nil` when absent or blank (never throws).
    func optionalString(_ key: String) -> String? {
        guard let raw = lookup(key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Required http/https URL. Throws `.missing`, or `.invalidURL` when the value
    /// isn't a valid URL or is missing an http(s) scheme (e.g. a config value of
    /// "localhost:8080" instead of "http://localhost:8080").
    func requiredURL(_ key: String) throws -> URL {
        let raw = try requiredString(key)
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            throw ConfigError.invalidURL(key: key, value: raw)
        }
        return url
    }
}
