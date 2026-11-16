import Foundation
import UIKit
import AuthenticationServices
import CryptoKit

/// Native Auth0 login mirroring the web app's Auth0Provider setup
/// (authorization code + PKCE, refresh tokens, silent renewal).
final class Auth0Service: NSObject {
    struct Tokens {
        let accessToken: String
        let refreshToken: String?
        let idToken: String?
        let expiresAt: Date
    }

    struct AuthUser {
        let sub: String
        let email: String
        let name: String
        let picture: String?
    }

    enum AuthError: Error, LocalizedError {
        case loginRequired
        case invalidResponse
        case cancelled
        /// Auth0 redirected back with an error (e.g. access_denied / Service not found)
        case authorizationFailed(String)

        var errorDescription: String? {
            switch self {
            case .loginRequired: return "Login required"
            case .invalidResponse: return "Invalid authentication response"
            case .cancelled: return "Login cancelled"
            case .authorizationFailed(let message): return message
            }
        }
    }

    private static let accessTokenKey = "access_token"
    private static let refreshTokenKey = "refresh_token"
    private static let idTokenKey = "id_token"
    private static let expiresAtKey = "expires_at"

    private var webSession: ASWebAuthenticationSession?
    private let send: (URLRequest) async throws -> (Data, URLResponse)
    private let vault: TokenVault
    private var refreshTask: Task<Tokens, Error>?
    /// Moves on when the session is cleared, so a refresh still in flight can't bring it back.
    private var sessionGeneration = 0

    init(
        vault: TokenVault = KeychainVault(),
        send: @escaping (URLRequest) async throws -> (Data, URLResponse) = { try await APIClient.session.data(for: $0) }
    ) {
        self.vault = vault
        self.send = send
        super.init()
    }

    // MARK: - Public API

    var hasSession: Bool { vault.get(Self.refreshTokenKey) != nil }

    /// Interactive login via Auth0 Universal Login.
    @MainActor
    func login() async throws -> Tokens {
        let verifier = Self.randomURLSafeString(length: 64)
        let challenge = Self.codeChallenge(for: verifier)
        let state = Self.randomURLSafeString(length: 32)

        var components = URLComponents(string: "https://\(AppConfig.Auth0.domain)/authorize")!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: AppConfig.Auth0.clientId),
            URLQueryItem(name: "redirect_uri", value: AppConfig.Auth0.callbackURL),
            URLQueryItem(name: "scope", value: AppConfig.Auth0.scope),
            URLQueryItem(name: "audience", value: AppConfig.Auth0.audience),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]

        let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: components.url!,
                callbackURLScheme: AppConfig.Auth0.callbackScheme
            ) { url, error in
                if let url {
                    continuation.resume(returning: url)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: AuthError.cancelled)
                } else {
                    continuation.resume(throwing: error ?? AuthError.invalidResponse)
                }
            }
            session.presentationContextProvider = self
            // Every sign-in starts fresh: Safari's login must never decide who uses the app, and
            // the two can be different people. This also leaves no Auth0 session behind to end at logout.
            session.prefersEphemeralWebBrowserSession = true
            self.webSession = session
            session.start()
        }

        guard let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems else {
            throw AuthError.invalidResponse
        }
        // Auth0 reports authorization failures via error/error_description
        if let error = items.first(where: { $0.name == "error" })?.value {
            let description = items.first(where: { $0.name == "error_description" })?.value
            throw AuthError.authorizationFailed(description ?? error)
        }
        guard let code = items.first(where: { $0.name == "code" })?.value,
              items.first(where: { $0.name == "state" })?.value == state else {
            throw AuthError.invalidResponse
        }

        let tokens = try await exchangeToken(params: [
            "grant_type": "authorization_code",
            "client_id": AppConfig.Auth0.clientId,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": AppConfig.Auth0.callbackURL,
        ])
        store(tokens)
        return tokens
    }

    /// Mirrors getAccessTokenSilently: cached token if fresh, else refresh.
    func getAccessTokenSilently() async throws -> String {
        if let token = vault.get(Self.accessTokenKey),
           let expiresRaw = vault.get(Self.expiresAtKey),
           let expires = TimeInterval(expiresRaw),
           Date(timeIntervalSince1970: expires) > Date().addingTimeInterval(60) {
            return token
        }
        guard let refreshToken = vault.get(Self.refreshTokenKey) else {
            throw AuthError.loginRequired
        }
        return try await (refreshTask ?? startRefresh(using: refreshToken)).value.accessToken
    }

    /// Requests that find the token expired all wait on this one exchange: Auth0 rotates refresh
    /// tokens, and treats a second use of an old one as theft by revoking the whole session.
    private func startRefresh(using refreshToken: String) -> Task<Tokens, Error> {
        let session = sessionGeneration
        let task = Task { () throws -> Tokens in
            defer { if session == sessionGeneration { refreshTask = nil } }
            do {
                let tokens = try await exchangeToken(params: [
                    "grant_type": "refresh_token",
                    "client_id": AppConfig.Auth0.clientId,
                    "refresh_token": refreshToken,
                ])
                guard session == sessionGeneration else { throw AuthError.loginRequired }
                store(tokens)
                return tokens
            } catch let error as APIError where error.status == 403 || error.status == 401 || error.status == 400 {
                // Refresh token revoked/expired — login required
                if session == sessionGeneration { clearSession() }
                throw AuthError.loginRequired
            }
        }
        refreshTask = task
        return task
    }

    /// Local logout (clears tokens). Matches logout({ localOnly: true }).
    func clearSession() {
        sessionGeneration += 1
        refreshTask = nil
        vault.delete(Self.accessTokenKey)
        vault.delete(Self.refreshTokenKey)
        vault.delete(Self.idTokenKey)
        vault.delete(Self.expiresAtKey)
    }

#if DEBUG
    /// Debug-only: install a session from externally-provided tokens, for headless
    /// testing where the interactive `ASWebAuthenticationSession` login can't run
    /// (CI / no-GUI simulator). Compiled out of Release builds entirely.
    func installDebugSession(accessToken: String, idToken: String?, refreshToken: String?, expiresAt: Date) {
        vault.set(accessToken, for: Self.accessTokenKey)
        vault.set(String(expiresAt.timeIntervalSince1970), for: Self.expiresAtKey)
        if let idToken { vault.set(idToken, for: Self.idTokenKey) }
        if let refreshToken { vault.set(refreshToken, for: Self.refreshTokenKey) }
    }

    /// Debug-only, for running the real refresh paths against Auth0 from a real sign-in.
    func debugExpireAccessToken() { vault.set("0", for: Self.expiresAtKey) }
    func debugBreakRefreshToken() { vault.set("invalid", for: Self.refreshTokenKey) }
#endif

    /// User profile decoded from the stored ID token (Auth0 user). In DEBUG, falls
    /// back to the access token's `sub` claim when no ID token is present (headless
    /// token injection, where only an access token may be available).
    func currentUser() -> AuthUser? {
        if let idToken = vault.get(Self.idTokenKey),
           let payload = Self.decodeJWTPayload(idToken) {
            return AuthUser(
                sub: payload["sub"] as? String ?? "",
                email: payload["email"] as? String ?? "",
                name: payload["name"] as? String ?? "",
                picture: payload["picture"] as? String
            )
        }
        #if DEBUG
        if let accessToken = vault.get(Self.accessTokenKey),
           let payload = Self.decodeJWTPayload(accessToken),
           let sub = payload["sub"] as? String {
            return AuthUser(
                sub: sub,
                email: payload["email"] as? String ?? "",
                name: payload["name"] as? String ?? "",
                picture: nil
            )
        }
        #endif
        return nil
    }

    // MARK: - Internals

    private func exchangeToken(params: [String: String]) async throws -> Tokens {
        var request = URLRequest(url: URL(string: "https://\(AppConfig.Auth0.domain)/oauth/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = params
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0.value)" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await send(request)
        guard let http = response as? HTTPURLResponse else { throw AuthError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: String(data: data, encoding: .utf8) ?? L("auth.tokenExchangeFailed"))
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accessToken = json["access_token"] as? String else {
            throw AuthError.invalidResponse
        }
        let expiresIn = (json["expires_in"] as? TimeInterval) ?? 86400
        return Tokens(
            accessToken: accessToken,
            refreshToken: json["refresh_token"] as? String,
            idToken: json["id_token"] as? String,
            expiresAt: Date().addingTimeInterval(expiresIn)
        )
    }

    private func store(_ tokens: Tokens) {
        vault.set(tokens.accessToken, for: Self.accessTokenKey)
        vault.set(String(tokens.expiresAt.timeIntervalSince1970), for: Self.expiresAtKey)
        if let refresh = tokens.refreshToken { vault.set(refresh, for: Self.refreshTokenKey) }
        if let idToken = tokens.idToken { vault.set(idToken, for: Self.idTokenKey) }
    }

    private static func randomURLSafeString(length: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncodedString()
    }

    private static func codeChallenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Data(digest).base64URLEncodedString()
    }

    /// Mirrors src/utils/parseJwt.ts
    static func decodeJWTPayload(_ jwt: String) -> [String: Any]? {
        let parts = jwt.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var base64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        guard let data = Data(base64Encoded: base64) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

extension Auth0Service: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // Must be a real window from the active scene: without one the session can fail to present.
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) { return window }
        guard let scene = scenes.first else { preconditionFailure("Sign-in always starts from a visible scene.") }
        return ASPresentationAnchor(windowScene: scene)
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
