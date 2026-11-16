#if canImport(Sentry)
import Foundation
import Sentry

/// Sentry-backed `ErrorReporter`. Installed by `AppObservability.start()` only when
/// a DSN is configured (`AppConfig.sentryDSN`). Crash/exception capture plus manual
/// `capture`/`captureMessage` call sites route here. No DSN → this is never created
/// and the app falls back to `LoggingErrorReporter` (OSLog), so Sentry is fully
/// opt-in via env config and ships disabled by default.
struct SentryReporter: ErrorReporter {
    init(dsn: String, environment: String) {
        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = environment
            options.releaseName = Self.release
            // Crash + unhandled-exception reporting is on by default. Keep PII off
            // (no request bodies / prompts) — content logging is APP_ENV-gated server-side.
            options.sendDefaultPii = false
            options.enableAutoSessionTracking = true
            // Light performance sampling; prod can tune via remote config later.
            options.tracesSampleRate = 0.1
        }
    }

    func capture(_ error: Error, context: [String: String]) {
        SentrySDK.capture(error: error) { scope in
            for (key, value) in context { scope.setTag(value: value, key: key) }
        }
    }

    func captureMessage(_ message: String) {
        SentrySDK.capture(message: message)
    }

    private static var release: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        let bundleId = Bundle.main.bundleIdentifier ?? "com.unbiase.ai"
        return "\(bundleId)@\(version)+\(build)"
    }
}
#endif
