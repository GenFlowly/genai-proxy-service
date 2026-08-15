import Foundation
import SwiftUI
import Combine

/// Mirrors src/context/AIContext.tsx — vendor/model selection, system prompt,
/// selected instruction, plus the model lists from the AIVendorWidget.
@MainActor
final class AIStore: ObservableObject {
    @Published var config: [AIConfig] = []
    @Published var systemPrompt: String = ""
    @Published var selectedInstructionId: String?
    @Published var modelsByVendor: [AIVendor: [String]] = [:]
    @Published var isLoadingModels = false

    private var customerId: String?

    func attach(customerId: String?) {
        guard self.customerId != customerId else { return }
        self.customerId = customerId
        guard let customerId else {
            systemPrompt = ""
            selectedInstructionId = nil
            return
        }
        systemPrompt = UserDefaults.standard.string(forKey: "\(customerId)_system_prompt") ?? ""
        selectedInstructionId = UserDefaults.standard.string(forKey: "\(customerId)_selected_instruction_id")
        if let data = UserDefaults.standard.data(forKey: "\(customerId)_ai_vendor_models"),
           let cached = try? JSONDecoder().decode([String: [String]].self, from: data) {
            modelsByVendor = Dictionary(uniqueKeysWithValues: cached.compactMap { key, value in
                AIVendor(rawValue: key).map { ($0, value) }
            })
        }
    }

    func persistSelections() {
        guard let customerId else { return }
        if systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            UserDefaults.standard.removeObject(forKey: "\(customerId)_system_prompt")
        } else {
            UserDefaults.standard.set(systemPrompt, forKey: "\(customerId)_system_prompt")
        }
        if let selectedInstructionId {
            UserDefaults.standard.set(selectedInstructionId, forKey: "\(customerId)_selected_instruction_id")
        } else {
            UserDefaults.standard.removeObject(forKey: "\(customerId)_selected_instruction_id")
        }
    }

    var selectedConfigs: [AIConfig] {
        config.filter { !$0.model.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    func isVendorActive(_ vendor: AIVendor) -> Bool {
        config.contains { $0.aiVendor == vendor }
    }

    func selectedModel(for vendor: AIVendor) -> String? {
        config.first { $0.aiVendor == vendor }?.model
    }

    func setSelectedModel(for vendor: AIVendor, model: String) {
        if let index = config.firstIndex(where: { $0.aiVendor == vendor }) {
            config[index].model = model
        } else {
            config.append(AIConfig(aiVendor: vendor, model: model))
        }
    }

    func removeVendor(_ vendor: AIVendor) {
        config.removeAll { $0.aiVendor == vendor }
    }

    /// Sync backend preferredModels into the active config (without clobbering
    /// manual selections), as AIVendorWidget does on first load.
    func applyPreferences(_ preferences: AIConfigPreferences?) {
        guard config.isEmpty, let preferred = preferences?.preferredModels else { return }
        config = preferred.filter { !$0.model.isEmpty }
    }

    func fetchModels(token: String, vendors: [AIVendor]) async {
        guard !vendors.isEmpty else { return }
        isLoadingModels = true
        defer { isLoadingModels = false }
        do {
            let response = try await TextGenerationModelsService.getModels(token: token, vendors: vendors)
            for entry in response.aiVendorModelList {
                modelsByVendor[entry.aiVendor] = entry.modelsList
            }
            if let customerId {
                let plain = Dictionary(uniqueKeysWithValues: modelsByVendor.map { ($0.key.rawValue, $0.value) })
                if let data = try? JSONEncoder().encode(plain) {
                    UserDefaults.standard.set(data, forKey: "\(customerId)_ai_vendor_models")
                }
            }
        } catch {
            // Keep cached lists
        }
    }
}
