import Foundation

enum HttpMethod: String {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

struct APIError: Error, LocalizedError {
    let status: Int
    let message: String
    /// The error response's body, for callers that read a machine-readable code from it.
    var body: Data? = nil

    var errorDescription: String? { message }
    var isAuthError: Bool { status == 401 || status == 403 }

    /// `response.statusText`. Credential saves show this, never the response body.
    var statusText: String {
        HTTPURLResponse.localizedString(forStatusCode: status).capitalized(with: Locale(identifier: "en_US"))
    }
}

/// Mirrors genai-react-app/src/utils/apiUtils.ts (fetchWithRetry) — exponential
/// backoff on 429/5xx and network errors.
enum APIClient {
    static let defaultRetries = 3
    static let defaultBackoff: TimeInterval = 1.0
    static let retryOnStatuses: Set<Int> = [429, 500, 502, 503, 504]
    static let browserFetchTimeout: TimeInterval = 300

    /// API responses hold account data, and the app caches what it needs in `CacheStore`, which
    /// logout clears. URLSession's own cache would keep a second copy on disk, and a response
    /// finishing during logout could land there after the wipe.
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    static func request(
        _ url: URL,
        method: HttpMethod = .get,
        token: String? = nil,
        body: (some Encodable)? = Optional<Int>.none,
        retries: Int = defaultRetries
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        // URLSession's default 60s would abort calls a browser waits out: an encoded note save
        // can run for minutes, and its autosave retry would then repeat that work forever.
        request.timeoutInterval = browserFetchTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }

        var attempt = 0
        while true {
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw APIError(status: -1, message: "Invalid response")
                }
                if (200..<300).contains(http.statusCode) {
                    return (data, http)
                }
                if retryOnStatuses.contains(http.statusCode), attempt < retries {
                    try await Task.sleep(nanoseconds: UInt64(defaultBackoff * pow(2, Double(attempt)) * 1_000_000_000))
                    attempt += 1
                    continue
                }
                let message = String(data: data, encoding: .utf8) ?? ""
                throw APIError(status: http.statusCode, message: "Request failed: \(http.statusCode) \(message)", body: data)
            } catch let error as APIError {
                throw error
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch {
                if attempt < retries {
                    try await Task.sleep(nanoseconds: UInt64(defaultBackoff * pow(2, Double(attempt)) * 1_000_000_000))
                    attempt += 1
                    continue
                }
                throw error
            }
        }
    }

    static func requestJSON<T: Decodable>(
        _ url: URL,
        method: HttpMethod = .get,
        token: String? = nil,
        body: (some Encodable)? = Optional<Int>.none,
        as type: T.Type
    ) async throws -> T {
        let (data, _) = try await request(url, method: method, token: token, body: body)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
