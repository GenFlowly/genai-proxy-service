import Foundation
import OSLog

/// App-wide error, crash and timing seam. Call sites report through
/// `AppObservability`, decoupled from any specific SDK. At launch, a Sentry-backed
/// reporter is installed when a DSN is configured (`AppConfig.sentryDSN`) and the
/// Sentry package is linked; otherwise events are logged locally via OSLog. This
/// keeps the app SDK-agnostic and lets Sentry drop in without touching call sites.
protocol ErrorReporter {
    func capture(_ error: Error, context: [String: String])
    func captureMessage(_ message: String)
    func startReply(vendor: String, model: String) -> ReplyTiming
}

extension ErrorReporter {
    func capture(_ error: Error) { capture(error, context: [:]) }
    func startReply(vendor: String, model: String) -> ReplyTiming { UntimedReply() }
}

/// Times one streamed reply, from sending the request to the end of the stream.
protocol ReplyTiming: AnyObject {
    /// Marks the reply's first text; later calls are ignored.
    func firstToken()
    func finish(error: Error?)
}

final class UntimedReply: ReplyTiming {
    func firstToken() {}
    func finish(error: Error?) {}
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
    private static let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.unbiase.ai", category: "observability")

    /// Installs the reporter once at app launch. Idempotent.
    static func start() {
        guard !started else { return }
        started = true
        #if canImport(Sentry)
        if let dsn = AppConfig.sentryDSN {
            reporter = SentryReporter(dsn: dsn, environment: AppConfig.environment.rawValue)
        }
        #endif
        // Device log only: sent to Sentry this would be one quota-counted event per app launch.
        logger.notice("observability started — env=\(AppConfig.environment.rawValue, privacy: .public), sentry=\(AppConfig.sentryDSN != nil ? "on" : "off", privacy: .public)")
    }

    static func capture(_ error: Error, context: [String: String] = [:]) { reporter.capture(error, context: context) }
    static func captureMessage(_ message: String) { reporter.captureMessage(message) }

    /// Runs [run] as one timed reply tagged with the vendor and model. A reply
    /// that throws, including one the user stops, finishes with an error status.
    static func timeReply<T>(
        _ aiConfig: AIConfig,
        reporter: ErrorReporter = AppObservability.reporter,
        _ run: (ReplyTiming) async throws -> T
    ) async throws -> T {
        let reply = reporter.startReply(vendor: aiConfig.aiVendor.rawValue, model: aiConfig.model)
        do {
            let result = try await run(reply)
            reply.finish(error: nil)
            return result
        } catch {
            reply.finish(error: error)
            throw error
        }
    }
}
