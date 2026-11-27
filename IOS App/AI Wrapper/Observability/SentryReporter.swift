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
            // Every session: with few users, a sample leaves too little for a p95 or p99.
            options.tracesSampleRate = 1.0
            options.beforeBreadcrumb = SentryScrubbing.breadcrumb
            options.beforeSendSpan = SentryScrubbing.span
            options.beforeSend = SentryScrubbing.event
        }
    }

    func startReply(vendor: String, model: String) -> ReplyTiming {
        SentryReplyTiming(vendor: vendor, model: model)
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

/// An `ai.reply` transaction, with the time to the first text as an
/// `ai.reply.first_token` child span.
final class SentryReplyTiming: ReplyTiming {
    private let reply: Span
    private var firstTokenSeen = false

    init(vendor: String, model: String) {
        reply = SentrySDK.startTransaction(name: "reply", operation: "ai.reply")
        reply.setData(value: vendor, key: "ai.vendor")
        reply.setData(value: model, key: "ai.model")
    }

    func firstToken() {
        guard !firstTokenSeen else { return }
        firstTokenSeen = true
        let span = reply.startChild(operation: "ai.reply.first_token", description: "first token")
        span.startTimestamp = reply.startTimestamp
        span.finish()
    }

    func finish(error: Error?) {
        reply.finish(status: error == nil ? .ok : .internalError)
    }
}

/// Query strings hold search terms and signed S3 links. SDK 9 keeps them in
/// network breadcrumbs, spans and failed-request events whatever
/// `sendDefaultPii` says. The SDK calls these off the main thread.
nonisolated enum SentryScrubbing {
    static let urlPartKeys = ["http.query", "http.fragment"]

    static func breadcrumb(_ breadcrumb: Breadcrumb) -> Breadcrumb? {
        for key in urlPartKeys { breadcrumb.setData(value: nil, key: key) }
        return breadcrumb
    }

    static func span(_ span: Span) -> Span? {
        for key in urlPartKeys { span.removeData(key: key) }
        return span
    }

    static func event(_ event: Event) -> Event? {
        event.request?.queryString = nil
        event.request?.fragment = nil
        return event
    }
}
#endif
