import Foundation
import SwiftUI
import Combine

/// Mirrors src/context/AuthContext.tsx — Auth0 session + backend onboard sync, with
/// stale-while-revalidate caches in SwiftData (web uses localStorage).
@MainActor
final class AuthStore: ObservableObject {
    static let onboardRetryDelay: TimeInterval = 45

    let auth0: Auth0Service

    @Published var customerId: String? = CacheStore.shared.readString(StorageSuffix.customerIdGlobal)
    @Published var aiVendorAPIKeyStatusList: [AIVendorAPIKeyStatus] = []
    @Published var vectorDBConfigStatusList: [VectorDBConfigStatus] = []
    @Published var aiConfigPreferences: AIConfigPreferences?
    @Published var customerInstructions: [InstructionResponse] = []
    @Published var customerName: String?
    @Published var customerPicture: String?
    @Published var isOnboarding = false
    @Published var isInstructionsLoaded = false
    @Published var isAuth0Authenticated = false
    /// Server cache-version counters from /onboard (agents, requestAgents, projects);
    /// nil until the sync settles. They gate the version-gated client caches.
    @Published var cacheVersions: [String: Int]?
    /// First-run onboarding gate (missing → true, mirroring the web).
    @Published var onboardingCompleted: Bool = true

    private var onboardRetryTask: Task<Void, Never>?
    private var onboardFailed = false
    /// `/instructions` holds every version and `/onboard` only the newest of each, and they can
    /// land in either order. Once the first has, the second mustn't overwrite it.
    private var hasAllInstructionVersions = false

    /// Lets the other stores drop what they hold in memory, before the wipe below.
    var onLogout: (() -> Void)?

    /// Strict authentication: Auth0 session AND onboarded customerId.
    var isAuthenticated: Bool { isAuth0Authenticated && customerId != nil }
    var canShare: Bool { isAuthenticated }

    var user: Auth0Service.AuthUser? {
        guard let auth0User = auth0.currentUser() else { return nil }
        // Strict display: prefer backend name/picture over Auth0 claims.
        return Auth0Service.AuthUser(
            sub: auth0User.sub,
            email: auth0User.email,
            name: customerName ?? "",
            picture: customerPicture
        )
    }

    init(auth0: Auth0Service = Auth0Service()) {
        self.auth0 = auth0
        var debugAuthed = false
        #if DEBUG
        // Headless testing: install a session from launch-argument tokens
        // (`-debugAccessToken`, `-debugIdToken`, `-debugRefreshToken`) when the
        // interactive login can't run. Foundation maps `-key value` launch args
        // into UserDefaults' (volatile) argument domain, so nothing is persisted.
        if let accessToken = UserDefaults.standard.string(forKey: "debugAccessToken"),
           !accessToken.isEmpty {
            auth0.installDebugSession(
                accessToken: accessToken,
                idToken: UserDefaults.standard.string(forKey: "debugIdToken"),
                refreshToken: UserDefaults.standard.string(forKey: "debugRefreshToken"),
                expiresAt: Date().addingTimeInterval(86_400)
            )
            debugAuthed = true
        }
        if CommandLine.arguments.contains("--debug-expire-access-token") { auth0.debugExpireAccessToken() }
        if CommandLine.arguments.contains("--debug-break-refresh-token") { auth0.debugBreakRefreshToken() }
        #endif
        isAuth0Authenticated = debugAuthed || auth0.hasSession
        if let customerId {
            loadCaches(customerId: customerId)
        }
        if isAuth0Authenticated {
            Task { await onboard() }
        }
    }

    // MARK: - Session

    func login() async throws {
        _ = try await auth0.login()
        isAuth0Authenticated = true
        await onboard()
    }

    func logout() {
        onboardRetryTask?.cancel()
        onLogout?()
        // In-memory state
        customerId = nil
        aiVendorAPIKeyStatusList = []
        aiConfigPreferences = nil
        customerInstructions = []
        hasAllInstructionVersions = false
        vectorDBConfigStatusList = []
        cacheVersions = nil
        customerName = nil
        customerPicture = nil
        isInstructionsLoaded = false
        onboardingCompleted = true
        // Tokens (Keychain)
        auth0.clearSession()
        isAuth0Authenticated = false
        ProviderCatalog.shared.reset()
        LocalSessionData.wipe()
    }

    /// Mirrors getAccessTokenSilently with logout-on-login_required.
    func getAccessTokenSilently() async throws -> String {
        do {
            return try await auth0.getAccessTokenSilently()
        } catch Auth0Service.AuthError.loginRequired {
            logout()
            throw Auth0Service.AuthError.loginRequired
        }
    }

    // MARK: - Onboard sync

    func onboard() async {
        guard isAuth0Authenticated, let auth0User = auth0.currentUser() else { return }
        isOnboarding = true
        defer { isOnboarding = false }
        do {
            let token = try await getAccessTokenSilently()
            let data = try await OnboardUserService.onboardCustomer(user: auth0User, token: token)
            // Signed out while this was in flight.
            guard isAuth0Authenticated else { return }

            if let newCustomerId = data.customerId {
                if newCustomerId != customerId { hasAllInstructionVersions = false }
                customerId = newCustomerId
                CacheStore.shared.writeString(newCustomerId, key: StorageSuffix.customerIdGlobal)
            }
            if let statuses = data.aiVendorAPIKeyStatusList {
                // Key STATUSES are credential-adjacent — NEVER persisted; repopulated
                // from /onboard each launch (mirrors the web's storageKeys.ts rule).
                aiVendorAPIKeyStatusList = statuses
            }
            if let instructions = data.customerInstructions {
                applyOnboardInstructions(instructions)
            }
            if let name = data.customerName { customerName = name }
            if let picture = data.customerPicture { customerPicture = picture }
            if let prefs = data.aiConfigPreferences {
                aiConfigPreferences = prefs
                writeCache(prefs, key: preferencesCacheKey)
            }
            if let vectorConfigs = data.vectorDBConfigStatusList { vectorDBConfigStatusList = vectorConfigs }
            cacheVersions = data.cacheVersions ?? [:]
            onboardingCompleted = data.onboardingCompleted ?? true
            onboardFailed = false
            // Names and options follow when it arrives; a slow catalog mustn't hold the app back.
            Task { await ProviderCatalog.shared.load(token: token) }
        } catch Auth0Service.AuthError.loginRequired {
            // Already logged out by getAccessTokenSilently
        } catch {
            AppObservability.captureMessage("onboard failed: \(error)")
            onboardFailed = true
            // Transient failure: keep the session on cached data and retry later.
            onboardRetryTask?.cancel()
            onboardRetryTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.onboardRetryDelay * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.onboard()
            }
        }
    }

    /// Mirrors the web's `checkSession`: on coming back, a failed sync doesn't wait out its retry
    /// timer, and a session that ended while away shows as signed out straight away.
    func applyOnboardInstructions(_ instructions: [InstructionResponse]) {
        guard !hasAllInstructionVersions else { return }
        customerInstructions = instructions
        writeCache(instructions, key: instructionsCacheKey)
    }

    func applyFetchedInstructions(_ instructions: [InstructionResponse], signedIn: Bool) {
        if signedIn { hasAllInstructionVersions = true }
        customerInstructions = instructions
        writeCache(instructions, key: instructionsCacheKey)
    }

    func checkSessionOnReturn() async {
        guard isAuth0Authenticated else { return }
        if onboardFailed {
            onboardFailed = false
            onboardRetryTask?.cancel()
            await onboard()
        }
        _ = try? await getAccessTokenSilently()
    }

    // MARK: - Instructions

    func refreshInstructions() async {
        do {
            var token = ""
            if isAuth0Authenticated {
                token = (try? await getAccessTokenSilently()) ?? ""
            }
            let session = customerId
            let response = try await InstructionService.getCustomerInstructions(token: token)
            guard session == customerId else { return }
            applyFetchedInstructions(response.instructions, signedIn: !token.isEmpty)
        } catch {
            // Keep cached data
        }
        isInstructionsLoaded = true
    }

    /// Upsert by (id, version); new versions are prepended.
    func updateInstruction(_ instruction: InstructionResponse) {
        if let index = customerInstructions.firstIndex(where: { $0.id == instruction.id && $0.version == instruction.version }) {
            customerInstructions[index] = instruction
        } else {
            customerInstructions.insert(instruction, at: 0)
        }
        writeCache(customerInstructions, key: instructionsCacheKey)
    }

    /// Write-through for model preferences: mirrors a successful save locally so every
    /// surface reflects it without waiting for the next /onboard sync.
    func mergePreferences(
        preferredModels: [AIConfig]? = nil,
        preferredAgentId: String? = nil,
        embeddingModelConversations: String? = nil,
        embeddingModelNotes: String? = nil,
        memoryLearnFromChats: Bool? = nil,
        memoryUseInReplies: Bool? = nil
    ) {
        var prefs = aiConfigPreferences ?? AIConfigPreferences()
        if let preferredModels { prefs.preferredModels = preferredModels }
        if let preferredAgentId { prefs.preferredAgentId = preferredAgentId }
        if let embeddingModelConversations { prefs.embeddingModelConversations = embeddingModelConversations }
        if let embeddingModelNotes { prefs.embeddingModelNotes = embeddingModelNotes }
        if let memoryLearnFromChats { prefs.memoryLearnFromChats = memoryLearnFromChats }
        if let memoryUseInReplies { prefs.memoryUseInReplies = memoryUseInReplies }
        aiConfigPreferences = prefs
        writeCache(prefs, key: preferencesCacheKey)
    }

    /// Runs the onboard sync again, after a change that makes the cached key statuses stale
    /// (AuthContext.resyncAccount).
    func resyncAccount() {
        Task { await onboard() }
    }

    func updateVendorApiKeyStatus(_ status: AIVendorAPIKeyStatus) {
        if let index = aiVendorAPIKeyStatusList.firstIndex(where: { $0.aiVendor == status.aiVendor }) {
            aiVendorAPIKeyStatusList[index] = status
        } else {
            aiVendorAPIKeyStatusList.append(status)
        }
        // Not persisted — credential-adjacent (see onboard()).
    }

    func updateVectorDBConfigStatus(_ status: VectorDBConfigStatus) {
        if let index = vectorDBConfigStatusList.firstIndex(where: { $0.vendor == status.vendor }) {
            vectorDBConfigStatusList[index] = status
        } else {
            vectorDBConfigStatusList.append(status)
        }
    }

    // MARK: - Caches

    private var instructionsCacheKey: String? { customerId.map { StorageSuffix.customerKey($0, StorageSuffix.instructions) } }
    private var preferencesCacheKey: String? { customerId.map { StorageSuffix.customerKey($0, StorageSuffix.aiPreferences) } }

    private func loadCaches(customerId: String) {
        // NOTE: vendor API-key STATUSES are deliberately NOT cached (credential-adjacent).
        if let instructions: [InstructionResponse] = CacheStore.shared.read(key: StorageSuffix.customerKey(customerId, StorageSuffix.instructions)) {
            customerInstructions = instructions
        }
        if let prefs: AIConfigPreferences = CacheStore.shared.read(key: StorageSuffix.customerKey(customerId, StorageSuffix.aiPreferences)) {
            aiConfigPreferences = prefs
        }
        ProviderCatalog.shared.paintFromCache()
    }

    private func writeCache(_ value: some Encodable, key: String?) {
        guard let key else { return }
        CacheStore.shared.write(value, key: key)
    }
}
