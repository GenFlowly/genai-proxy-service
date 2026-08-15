import SwiftUI

/// Mirrors InstructionsPage — "Instructions Hub" heading + Create Instruction
/// pill + grid of instruction tiles.
struct InstructionsPageView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter

    /// Latest version per instruction id (page dedupes to latest).
    private var latestInstructions: [InstructionResponse] {
        var byId: [String: InstructionResponse] = [:]
        for instruction in auth.customerInstructions where (byId[instruction.id]?.version ?? -1) < instruction.version {
            byId[instruction.id] = instruction
        }
        return byId.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeaderView(title: "Instructions Hub", subtitle: nil) {
                PillButton(label: "Create Instruction") {
                    router.navigate(.instructionDetail(nil))
                }
            }

            if latestInstructions.isEmpty {
                Text("No instructions found. Create one to get started!")
                    .foregroundStyle(AppTheme.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding()
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 12)], spacing: 12) {
                        ForEach(latestInstructions) { instruction in
                            Button {
                                router.navigate(.instructionDetail(instruction.id))
                            } label: {
                                InstructionTileView(instruction: instruction)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.background)
        .task {
            await auth.refreshInstructions()
        }
    }
}

struct InstructionTileView: View {
    var instruction: InstructionResponse

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "person.crop.rectangle")
                    .foregroundStyle(AppTheme.primary)
                Text(instruction.name.isEmpty ? "Untitled Instruction" : instruction.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
            }
            Text(String(instruction.instruction.prefix(140)) + (instruction.instruction.count > 140 ? "..." : ""))
                .font(.caption)
                .foregroundStyle(AppTheme.textMuted)
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
            Text("v\(instruction.version)")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(AppTheme.backgroundTertiary)
                .clipShape(Capsule())
                .foregroundStyle(AppTheme.textMuted)
        }
        .padding(12)
        .frame(minHeight: 130)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.borderLight, lineWidth: 1))
    }
}

/// Mirrors InstructionDetailPage — "← Back" + Create/Edit heading with
/// Share / Delete / Save pill actions, Name input, Instruction Prompt editor.
struct InstructionDetailView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    @EnvironmentObject var router: AppRouter

    /// nil = create mode (web route /instructions/new)
    let instructionId: String?

    @State private var name = ""
    @State private var text = ""
    @State private var role: String = "OWNER"
    @State private var isSaving = false
    @State private var showDeleteConfirm = false
    @State private var showShare = false
    @State private var loadedInstruction: InstructionResponse?

    private var isNew: Bool { instructionId == nil }
    private var isViewOnly: Bool { role == "VIEW" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: ← Back + title + actions
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    router.navigate(.instructions)
                } label: {
                    Text("← Back")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.primary)
                }
                HStack {
                    Text(isNew ? "Create Instruction" : "Edit Instruction")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppTheme.textPrimary)
                    Spacer()
                    if !isViewOnly {
                        if !isNew, auth.canShare {
                            PillButton(label: "Share", style: .secondary) { showShare = true }
                        }
                        if !isNew, role == "OWNER" {
                            PillButton(label: "Delete", style: .danger) { showDeleteConfirm = true }
                        }
                        PillButton(
                            label: isSaving ? "Saving..." : "Save",
                            disabled: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving
                        ) {
                            Task { await save() }
                        }
                    }
                }
            }
            .padding()
            .background(AppTheme.backgroundSecondary)
            .overlay(alignment: .bottom) { Divider() }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if isViewOnly {
                        Text("You are viewing a shared instruction. You cannot make changes.")
                            .font(.caption)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(AppTheme.backgroundTertiary)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Name").font(.caption.weight(.medium)).foregroundStyle(AppTheme.textMuted)
                        TextField("e.g., Code Reviewer Persona", text: $name)
                            .textFieldStyle(.roundedBorder)
                            .disabled(isViewOnly)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Instruction Prompt").font(.caption.weight(.medium)).foregroundStyle(AppTheme.textMuted)
                        TextEditor(text: $text)
                            .font(.body)
                            .disabled(isViewOnly)
                            .frame(minHeight: 300)
                            .padding(4)
                            .scrollContentBackground(.hidden)
                            .background(AppTheme.backgroundSecondary)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppTheme.border, lineWidth: 1))
                    }
                }
                .padding()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.background)
        .confirmationDialog("Delete this instruction?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task { await deleteInstruction() }
            }
        }
        .sheet(isPresented: $showShare) {
            if let instructionId {
                ShareSheetView(target: .instruction(instructionId))
            }
        }
        .onAppear(perform: loadInstruction)
    }

    private func loadInstruction() {
        guard let instructionId, loadedInstruction == nil else { return }
        let latest = auth.customerInstructions
            .filter { $0.id == instructionId }
            .max { $0.version < $1.version }
        if let latest {
            loadedInstruction = latest
            name = latest.name
            text = latest.instruction
            role = latest.role ?? "OWNER"
        } else if auth.isAuthenticated {
            toasts.showToast("You do not have access to this instruction or it doesn't exist.")
            router.navigate(.instructions)
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            let response = try await InstructionService.createInstruction(
                token: token,
                request: CreateInstructionRequest(
                    instruction: text,
                    instructionName: name.isEmpty ? nil : name,
                    existingInstructionId: instructionId
                )
            )
            auth.updateInstruction(response)
            toasts.showToast("Instruction saved")
            if isNew { router.navigate(.instructionDetail(response.id)) }
        } catch {
            toasts.showToast("Failed to save instruction")
        }
    }

    private func deleteInstruction() async {
        guard let instructionId else { return }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await InstructionService.deleteInstruction(token: token, instructionId: instructionId)
            auth.customerInstructions.removeAll { $0.id == instructionId }
            router.navigate(.instructions)
        } catch {
            toasts.showToast("Failed to delete instruction")
        }
    }
}
