import Foundation
import Network
import UIKit

/// Where a reply's durable run has got to on this client: the run, and the last event applied.
/// A dropped stream reattaches after [lastSeq], so nothing is shown twice or lost.
@MainActor
final class ReplyCursor {
    var runId: String?
    var lastSeq = 0
    /// False once a reattach finds the run over: its reply is saved, nothing more will stream.
    var active = true

    init(runId: String? = nil) { self.runId = runId }
}

/// When a dropped reply stream can usefully reconnect: the app is in the foreground and has a
/// network path. iOS closes a suspended app's sockets, so a retry in the background only fails.
@MainActor
final class ReconnectGate {
    static let shared = ReconnectGate()

    private let monitor = NWPathMonitor()
    private var online = true

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in self?.online = satisfied }
        }
        monitor.start(queue: DispatchQueue(label: "ReconnectGate"))
    }

    var isOpen: Bool { online && UIApplication.shared.applicationState == .active }

    /// Returns once the app is in the foreground and online. A suspended app doesn't run, so this
    /// costs nothing while away; the check after return is at most half a second late.
    func waitUntilOpen() async {
        while !isOpen && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }
}

/// Asks iOS to keep the app running briefly after it leaves the foreground, so a short reply
/// can finish on its open stream. Ends at [end] or when iOS calls time, whichever is first.
@MainActor
final class BackgroundTime {
    private var id: UIBackgroundTaskIdentifier = .invalid

    init(_ name: String) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

/// A dropped connection rather than a failure: the app was suspended, the network went away,
/// or this client hung up. The server's run carries on, so it's resumed, never reported.
enum NetworkLoss {
    static func matches(_ error: Error) -> Bool {
        if error is StreamTruncatedError || error is CancellationError { return true }
        guard let code = (error as? URLError)?.code else { return false }
        return [.networkConnectionLost, .notConnectedToInternet, .timedOut, .cancelled,
                .cannotConnectToHost, .dataNotAllowed, .internationalRoamingOff].contains(code)
    }
}

/// A reply whose recovery gave up after several attempts in the foreground. Reported once.
struct ReplyRecoveryFailed: Error, CustomStringConvertible {
    let underlying: Error
    var description: String { "Reply recovery gave up: \(underlying)" }
}
