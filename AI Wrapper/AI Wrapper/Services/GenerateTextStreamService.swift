import Foundation

/// Mirrors src/services/generateTextStreamService.ts
struct StreamMetadata {
    var conversationId: String?
    var messageId: String?
    var responseMessageId: String?
    var aiVendor: String?
    var inputTokens: Int?
    var outputTokens: Int?
    var totalTokens: Int?
    var tokensReadFromCache: Int?
}

enum GenerateTextStreamService {
    /// Streams newline-delimited JSON: {"t":"c","v":"<content delta>"} and
    /// {"t":"k","v":"<thinking step>"}. Other message types are ignored.
    /// Non-JSON lines are emitted verbatim as content (error/legacy format).
    static func generateTextStream(
        token: String,
        request body: GenerateTextStreamRequest,
        onDelta: @escaping (String) -> Void,
        onMetadata: ((StreamMetadata) -> Void)? = nil,
        onThinking: ((String) -> Void)? = nil
    ) async throws {
        var request = URLRequest(url: Endpoints.generateTextStream)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(body)
        request.timeoutInterval = 300

        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: -1, message: "Invalid response")
        }

        if http.statusCode == 401 || http.statusCode == 403 {
            throw Auth0Service.AuthError.loginRequired
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: "Text generation failed: \(http.statusCode)")
        }

        onMetadata?(StreamMetadata(
            conversationId: http.value(forHTTPHeaderField: "X-Conversation-Id"),
            messageId: http.value(forHTTPHeaderField: "X-Message-Id"),
            responseMessageId: http.value(forHTTPHeaderField: "X-Response-Message-Id"),
            aiVendor: http.value(forHTTPHeaderField: "X-Ai-Vendor")
        ))

        func processLine(_ line: String) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            if let data = trimmed.data(using: .utf8),
               let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let type = msg["t"] as? String {
                if type == "c", let value = msg["v"] as? String {
                    onDelta(value)
                } else if type == "k", let value = msg["v"] as? String {
                    onThinking?(value)
                }
                // other types (heartbeat, etc.) are silently ignored
            } else {
                onDelta(line)
            }
        }

        for try await line in bytes.lines {
            try Task.checkCancellation()
            processLine(line)
        }
    }
}
