import Foundation
import SwiftUI
import Combine

/// Mirrors src/context/AuthContext.tsx — Auth0 session + backend onboard sync,
/// with stale-while-revalidate caches in UserDefaults (web uses localStorage).
@MainActor
final class AuthStore: ObservableObject {
    static let onboardRetryDelay: TimeInterval = 45

    let auth0 = Auth0Service()

    @Published var customerId: String? = UserDefaults.standard.string(forKey: "customerId")
    @Published var aiVendorAPIKeyStatusList: [AIVendorAPIKeyStatus] = []
    @Published var vectorDBConfigStatusList: [VectorDBConfigStatus] = []
    @Published var supabaseConfigStatus: SupabaseConfigStatus?
    @Published var aiConfigPreferences: AIConfigPreferences?
    @Published var customerInstructions: [InstructionResponse] = []
    @Published var customerName: String?
    @Published var customerPicture: String?
    @Published var isOnboarding = false
    @Published var isInstructionsLoaded = false
    @Published var isAuth0Authenticated = false

    private var onboardRetryTask: Task<Void, Never>?

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

    init() {
        isAuth0Authenticated = auth0.hasSession
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
        customerId = nil
        aiVendorAPIKeyStatusList = []
        aiConfigPreferences = nil
        customerInstructions = []
        vectorDBConfigStatusList = []
        supabaseConfigStatus = nil
        customerName = nil
        customerPicture = nil
        UserDefaults.standard.removeObject(forKey: "customerId")
        auth0.clearSession()
        isAuth0Authenticated = false
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

            if let newCustomerId = data.customerId {
                customerId = newCustomerId
                UserDefaults.standard.set(newCustomerId, forKey: "customerId")
            }
            if let statuses = data.aiVendorAPIKeyStatusList {
                aiVendorAPIKeyStatusList = statuses
                writeCache(statuses, key: vendorKeysCacheKey)
            }
            if let instructions = data.customerInstructions {
                customerInstructions = instructions
                writeCache(instructions, key: instructionsCacheKey)
            }
            if let name = data.customerName { customerName = name }
            if let picture = data.customerPicture { customerPicture = picture }
            if let prefs = data.aiConfigPreferences {
                aiConfigPreferences = prefs
                writeCache(prefs, key: preferencesCacheKey)
            }
            if let vectorConfigs = data.vectorDBConfigStatusList { vectorDBConfigStatusList = vectorConfigs }
            if let supabase = data.supabaseConfigStatus { supabaseConfigStatus = supabase }
        } catch Auth0Service.AuthError.loginRequired {
            // Already logged out by getAccessTokenSilently
        } catch {
            // Transient failure: keep the session on cached data and retry later.
            onboardRetryTask?.cancel()
            onboardRetryTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.onboardRetryDelay * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.onboard()
            }
        }
    }

    // MARK: - Instructions

    func refreshInstructions() async {
        do {
            var token = ""
            if isAuth0Authenticated {
                token = (try? await getAccessTokenSilently()) ?? ""
            }
            let response = try await InstructionService.getCustomerInstructions(token: token)
            customerInstructions = response.instructions
            writeCache(response.instructions, key: instructionsCacheKey)
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

    func updateVendorApiKeyStatus(_ status: AIVendorAPIKeyStatus) {
        if let index = aiVendorAPIKeyStatusList.firstIndex(where: { $0.aiVendor == status.aiVendor }) {
            aiVendorAPIKeyStatusList[index] = status
        } else {
            aiVendorAPIKeyStatusList.append(status)
        }
        writeCache(aiVendorAPIKeyStatusList, key: vendorKeysCacheKey)
    }

    func updateVectorDBConfigStatus(_ status: VectorDBConfigStatus) {
        if let index = vectorDBConfigStatusList.firstIndex(where: { $0.vendor == status.vendor }) {
            vectorDBConfigStatusList[index] = status
        } else {
            vectorDBConfigStatusList.append(status)
        }
    }

    // MARK: - Caches

    private var vendorKeysCacheKey: String? { customerId.map { "\($0)_vendor_api_key_statuses" } }
    private var instructionsCacheKey: String? { customerId.map { "\($0)_instructions" } }
    private var preferencesCacheKey: String? { customerId.map { "\($0)_ai_preferences" } }

    private func loadCaches(customerId: String) {
        if let statuses: [AIVendorAPIKeyStatus] = readCache(key: "\(customerId)_vendor_api_key_statuses") {
            aiVendorAPIKeyStatusList = statuses
        }
        if let instructions: [InstructionResponse] = readCache(key: "\(customerId)_instructions") {
            customerInstructions = instructions
        }
        if let prefs: AIConfigPreferences = readCache(key: "\(customerId)_ai_preferences") {
            aiConfigPreferences = prefs
        }
    }

    private func readCache<T: Decodable>(key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func writeCache(_ value: some Encodable, key: String?) {
        guard let key, let data = try? JSONEncoder().encode(value) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}
