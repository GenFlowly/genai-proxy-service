import Foundation

/// Mirrors src/services/generateTextStreamService.ts — the NDJSON chat wire
/// protocol shared by the live generate-text-stream and the durable-run
/// reattach stream.

/// Vendor failure relayed mid-stream (`{"t":"err"}` or `{"t":"done","status":"error"}`).
struct StreamGenerationError: Error { let message: String }

/// The stream ended without a `{"t":"done"}` terminal frame — the connection
/// was cut before the server said whether generation finished. Treated
/// leniently: the caller should try to recover the persisted message (the
/// normal shape of a backgrounded mobile app whose server-side run keeps going).
struct StreamTruncatedError: Error {}

struct StreamMetadata {
    var conversationId: String?
    var messageId: String?
    var responseMessageId: String?
    var aiVendor: String?
    /// Instruction the server actually applied (explicit pick, or the default).
    var instructionId: String?
}

/// Human-in-the-loop request from a durable run paused on an in-graph interrupt().
struct AwaitingInput: Equatable {
    var prompt: String?
    var runId: String?
}

/// Handlers for the NDJSON frames — one place for the frame vocabulary.
struct StreamCallbacks {
    var onDelta: (String) -> Void
    var onContentReset: () -> Void = {}
    var onStopReason: (String) -> Void = { _ in }
    var onThinking: (String) -> Void = { _ in }            // legacy flat `k`
    var onThinkingStep: (ThinkingStep) -> Void = { _ in }  // structured `ks`
    var onThinkingDuration: (Int) -> Void = { _ in }       // `kd`
    var onWebSources: ([WebSource]) -> Void = { _ in }      // `ws`
    var onGeneratedAttachments: ([AttachmentRef]) -> Void = { _ in }  // `ga`
    var onAwaitingInput: (AwaitingInput) -> Void = { _ in } // `ai` (HITL)
}

enum GenerateTextStreamService {

    /// Parse one NDJSON line and dispatch to [cb]. Returns true when the line
    /// was a terminal `done` frame. Throws on `err` / `done:error` / `[Error: …]`.
    static func processLine(_ line: String, _ cb: StreamCallbacks) throws -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        guard let data = trimmed.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = msg["t"] as? String else {
            // Not JSON. The proxy emits "[Error: <reason>]" as a raw line on
            // failure — surface it rather than appending to the text.
            if trimmed.hasPrefix("[Error:"), trimmed.hasSuffix("]") {
                let reason = String(trimmed.dropFirst(7).dropLast()).trimmingCharacters(in: .whitespaces)
                throw StreamGenerationError(message: reason.isEmpty ? "Stream failed" : reason)
            }
            cb.onDelta(line)   // legacy raw-text format
            return false
        }

        switch type {
        case "c":
            if let v = msg["v"] as? String { cb.onDelta(v) }
        case "cr":
            cb.onContentReset()
        case "sr":
            if let v = msg["v"] as? String, !v.isEmpty { cb.onStopReason(v) }
        case "k":
            if let v = msg["v"] as? String { cb.onThinking(v) }
        case "ks":
            // Parsed from the raw line: tool-call arguments must keep their key order.
            if let v = JSONValue.parse(trimmed)?["v"], let step = ThinkingStep(json: v) {
                cb.onThinkingStep(step)
            }
        case "kd":
            if let millis = (msg["v"] as? NSNumber)?.intValue { cb.onThinkingDuration(millis) }
        case "ws":
            if let v = msg["v"], let sources = decode([WebSource].self, from: v), !sources.isEmpty {
                cb.onWebSources(sources)
            }
        case "ga":
            if let arr = msg["v"] as? [[String: Any]] {
                let refs = arr.compactMap(normalizeAttachment).filter { !$0.attachmentId.isEmpty }
                if !refs.isEmpty { cb.onGeneratedAttachments(refs) }
            }
        case "ai":
            if let v = msg["v"] as? [String: Any] {
                cb.onAwaitingInput(AwaitingInput(prompt: v["prompt"] as? String, runId: (v["run_id"] as? String) ?? (v["runId"] as? String)))
            }
        case "err":
            throw StreamGenerationError(message: (msg["v"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? L("conversation.response.generationFailedDefault"))
        case "done":
            if (msg["status"] as? String) == "cancelled" { cb.onStopReason(StopReasonNote.cancelled) }
            if (msg["status"] as? String) == "error" {
                throw StreamGenerationError(message: (msg["m"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? L("conversation.response.generationFailedDefault"))
            }
            return true
        default:
            break   // heartbeat / unknown — ignored
        }
        return false
    }

    /// Read an NDJSON stream body and dispatch each frame. Throws
    /// `StreamTruncatedError` if the stream closes before a `done` frame.
    static func readNdjsonStream(_ bytes: URLSession.AsyncBytes, _ cb: StreamCallbacks) async throws {
        var doneFrameReceived = false
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if try processLine(line, cb) { doneFrameReceived = true }
        }
        if !doneFrameReceived { throw StreamTruncatedError() }
    }

    /// Normalize the retrieval-server's snake_case artifact shape to AttachmentRef.
    private static func normalizeAttachment(_ a: [String: Any]) -> AttachmentRef {
        AttachmentRef(
            attachmentId: (a["artifact_id"] as? String) ?? (a["attachmentId"] as? String) ?? "",
            s3Key: (a["key"] as? String) ?? (a["s3Key"] as? String),
            mediaType: (a["media_type"] as? String) ?? (a["mediaType"] as? String) ?? "application/octet-stream",
            filename: a["filename"] as? String,
            sizeBytes: (a["size_bytes"] as? NSNumber)?.intValue
        )
    }

    private static func decode<T: Decodable>(_ type: T.Type, from any: Any) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: any) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    /// Live generation stream. Reads metadata from response headers, then the body.
    static func generateTextStream(
        token: String,
        request body: GenerateTextStreamRequest,
        onMetadata: ((StreamMetadata) -> Void)? = nil,
        callbacks: StreamCallbacks
    ) async throws {
        var request = URLRequest(url: Endpoints.generateTextStream)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(body)
        request.timeoutInterval = 300

        let (bytes, response) = try await APIClient.session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: -1, message: "Invalid response")
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw Auth0Service.AuthError.loginRequired
        }
        if http.statusCode == 422 {
            var body = Data()
            for try await byte in bytes { body.append(byte) }
            if ModerationRefusal(body: body) == .contentBlocked {
                throw APIError(status: 422, message: L("moderation.postRefusedByFilter"))
            }
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: L("errors.ai.generateTextStreamFailed"))
        }

        onMetadata?(StreamMetadata(
            conversationId: http.value(forHTTPHeaderField: "X-Conversation-Id"),
            messageId: http.value(forHTTPHeaderField: "X-Message-Id"),
            responseMessageId: http.value(forHTTPHeaderField: "X-Response-Message-Id"),
            aiVendor: http.value(forHTTPHeaderField: "X-Ai-Vendor"),
            instructionId: http.value(forHTTPHeaderField: "X-Instruction-Id")
        ))

        try await readNdjsonStream(bytes, callbacks)
    }
}
