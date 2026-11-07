import Foundation

/// Cancel / reattach / resume for the decoupled durable-run generation model
/// (mirrors cancelGenerationService.ts, reattachRunService.ts, resumeRunService.ts).
enum StreamRecoveryService {

    /// True cancel of an in-flight generation. Aborting the socket alone no
    /// longer stops the model (generation is decoupled so it survives mobile
    /// backgrounding), so Stop also calls this. [id] is the client generationId
    /// (usable immediately) or the server responseMessageId. Retried — an
    /// unacknowledged cancel means the model keeps generating and billing.
    @discardableResult
    static func cancelGeneration(token: String, id: String) async -> Bool {
        guard !id.isEmpty else { return false }
        do {
            let (data, _) = try await APIClient.request(
                Endpoints.cancelGeneration(id), method: .post, token: token, retries: 2
            )
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            return (body?["cancelled"] as? Bool) == true
        } catch {
            return false
        }
    }

    /// Reattach to an in-flight durable run's event stream (reload/background
    /// recovery), replaying frames after [fromSeq]. A 404 means the run already
    /// finished — a no-op so a stale runId doesn't surface an error.
    static func reattachRun(
        token: String,
        runId: String,
        conversationId: String,
        fromSeq: Int = 0,
        callbacks: StreamCallbacks
    ) async throws {
        var request = URLRequest(url: Endpoints.reattachRun(runId, conversationId: conversationId, fromSeq: fromSeq))
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 300

        let (bytes, response) = try await APIClient.session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: -1, message: "Invalid response")
        }
        if http.statusCode == 404 { return }   // run already finished
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: "Reattach failed: \(http.statusCode)")
        }
        try await GenerateTextStreamService.readNdjsonStream(bytes, callbacks)
    }

    /// Deliver a human reply to a durable run paused on an in-graph interrupt().
    @discardableResult
    static func resumeRun(token: String, runId: String, conversationId: String, reply: [String: String]) async -> Bool {
        do {
            let (data, _) = try await APIClient.request(
                Endpoints.resumeRun(runId, conversationId: conversationId), method: .post, token: token, body: reply, retries: 0
            )
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            return (body?["resumed"] as? Bool) ?? true
        } catch {
            return false
        }
    }
}
