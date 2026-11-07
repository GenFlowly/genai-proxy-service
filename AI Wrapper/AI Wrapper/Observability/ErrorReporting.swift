import Foundation
import OSLog

/// App-wide error / crash reporting seam. Call sites report through
/// `AppObservability`, decoupled from any specific SDK. At launch, a Sentry-backed
/// reporter is installed when a DSN is configured (`AppConfig.sentryDSN`) and the
/// Sentry package is linked; otherwise events are logged locally via OSLog. This
/// keeps the app SDK-agnostic and lets Sentry drop in without touching call sites.
protocol ErrorReporter {
    func capture(_ error: Error, context: [String: String])
    func captureMessage(_ message: String)
}

extension ErrorReporter {
    func capture(_ error: Error) { capture(error, context: [:]) }
}

/// Always-available reporter backed by OSLog. Safe with no network / no DSN.
struct LoggingErrorReporter: ErrorReporter {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.unbiase.ai", category: "errors")

    func capture(_ error: Error, context: [String: String]) {
        logger.error("captured error: \(String(describing: error), privacy: .public) context=\(context, privacy: .public)")
    }

    func captureMessage(_ message: String) {
        logger.notice("\(message, privacy: .public)")
    }
}

enum AppObservability {
    private(set) nonisolated(unsafe) static var reporter: ErrorReporter = LoggingErrorReporter()
    private nonisolated(unsafe) static var started = false

    /// Installs the reporter once at app launch. Idempotent.
    static func start() {
        guard !started else { return }
        started = true
        #if canImport(Sentry)
        if let dsn = AppConfig.sentryDSN {
            reporter = SentryReporter(dsn: dsn, environment: AppConfig.environment.rawValue)
        }
        #endif
        captureMessage("observability started — env=\(AppConfig.environment.rawValue), sentry=\(AppConfig.sentryDSN != nil ? "on" : "off")")
    }

    static func capture(_ error: Error, context: [String: String] = [:]) { reporter.capture(error, context: context) }
    static func captureMessage(_ message: String) { reporter.captureMessage(message) }
}
