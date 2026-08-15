import SwiftUI

/// Mirrors MemoryPage — NotesHeader (title + save status), seamless notes
/// editor with autosave, and the Saved Notes sidebar as a slide-in panel.
struct MemoryPageView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var notes: [SavedNote] = []
    @State private var notesLoadState: LoadState = .idle
    @State private var activeNoteKey: String = MemoryPageView.newNoteKey()
    @State private var noteTitle: String?
    @State private var noteText = ""
    @State private var isNewNote = true
    @State private var saveState: SaveState = .idle
    @State private var showNotesPanel = false
    @State private var autosaveTask: Task<Void, Never>?
    @State private var lastSavedText = ""

    enum LoadState { case idle, loading, failed, loaded }
    enum SaveState: Equatable {
        case idle, saving, retrying
        case saved(Date)
    }

    static func newNoteKey() -> String {
        "note-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8))"
    }

    var body: some View {
        ZStack(alignment: .leading) {
            VStack(spacing: 0) {
                notesHeader
                if !auth.isAuthenticated {
                    LoginRequiredView(message: "Log in to use Memory")
                } else {
                    editor
                }
            }

            if showNotesPanel {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture { showNotesPanel = false }
                savedNotesPanel
                    .frame(width: 280)
                    .transition(.move(edge: .leading))
            }
        }
        .animation(.easeOut(duration: 0.2), value: showNotesPanel)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.background)
        .task { await loadNotes() }
    }

    // MARK: - NotesHeader

    private var headerTitle: String {
        if let noteTitle, !noteTitle.isEmpty { return noteTitle }
        return isNewNote ? "New Note" : "Untitled Note"
    }

    private var notesHeader: some View {
        HStack {
            Button {
                showNotesPanel.toggle()
            } label: {
                Image(systemName: "sidebar.left")
                    .foregroundStyle(AppTheme.textPrimary)
            }
            Text(headerTitle)
                .font(.headline)
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
            Spacer()
            saveStatusView
            Button {
                startNewNote()
            } label: {
                Image(systemName: "square.and.pencil")
                    .foregroundStyle(AppTheme.textPrimary)
            }
            .accessibilityLabel("New Note")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(AppTheme.backgroundSecondary)
        .overlay(alignment: .bottom) { Divider() }
    }

    @ViewBuilder
    private var saveStatusView: some View {
        switch saveState {
        case .idle:
            EmptyView()
        case .saving:
            Text("Saving…").font(.caption2).foregroundStyle(AppTheme.textMuted)
        case .retrying:
            Text("Couldn't save. Retrying…").font(.caption2).foregroundStyle(AppTheme.error)
        case .saved(let date):
            Text("Saved at \(date.formatted(date: .omitted, time: .shortened))")
                .font(.caption2)
                .foregroundStyle(AppTheme.textMuted)
        }
    }

    private var editor: some View {
        TextEditor(text: $noteText)
            .font(.body)
            .padding(8)
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .onChange(of: noteText) { _, newValue in
                scheduleAutosave(newValue)
            }
    }

    // MARK: - SavedNotesWidget panel

    private var savedNotesPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Saved Notes")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .padding()

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    switch notesLoadState {
                    case .loading, .idle:
                        Text("Loading notes...")
                            .font(.caption)
                            .foregroundStyle(AppTheme.textMuted)
                            .padding()
                    case .failed:
                        Text("Could not load notes")
                            .font(.caption)
                            .foregroundStyle(AppTheme.textMuted)
                            .padding()
                    case .loaded:
                        if notes.isEmpty {
                            Text("No saved notes yet")
                                .font(.caption)
                                .foregroundStyle(AppTheme.textMuted)
                                .padding()
                        } else {
                            ForEach(notes) { note in
                                Button {
                                    openNote(note)
                                    showNotesPanel = false
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(displayTitle(note))
                                            .font(.subheadline)
                                            .foregroundStyle(AppTheme.textPrimary)
                                            .lineLimit(1)
                                        Text(formattedDate(note.createdAt))
                                            .font(.caption2)
                                            .foregroundStyle(AppTheme.textMuted)
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(note.noteKey == activeNoteKey ? AppTheme.backgroundSelected : .clear)
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                }
                            }
                            .padding(.horizontal, 8)
                        }
                    }
                }
                .padding(.vertical, 8)
            }
        }
        .frame(maxHeight: .infinity)
        .background(AppTheme.sidebarBackground)
    }

    private func displayTitle(_ note: SavedNote) -> String {
        if !note.title.isEmpty { return note.title }
        let firstLine = note.noteValue
            .components(separatedBy: "\n")
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return firstLine ?? "Untitled"
    }

    private func formattedDate(_ raw: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        return date?.formatted(date: .abbreviated, time: .shortened) ?? raw
    }

    // MARK: - Note lifecycle

    private func startNewNote() {
        autosaveTask?.cancel()
        activeNoteKey = Self.newNoteKey()
        noteTitle = nil
        noteText = ""
        lastSavedText = ""
        isNewNote = true
        saveState = .idle
    }

    private func openNote(_ note: SavedNote) {
        autosaveTask?.cancel()
        activeNoteKey = note.noteKey
        noteTitle = note.title.isEmpty ? nil : note.title
        noteText = note.noteValue
        lastSavedText = note.noteValue
        isNewNote = false
        saveState = .idle
    }

    private func loadNotes() async {
        guard auth.isAuthenticated, notesLoadState != .loading else { return }
        notesLoadState = .loading
        do {
            let token = try await auth.getAccessTokenSilently()
            notes = try await NotesService.getNotes(token: token)
            notesLoadState = .loaded
        } catch {
            notesLoadState = .failed
        }
    }

    /// Debounced autosave mirroring useAutosave (flush ~1.5s after typing stops).
    private func scheduleAutosave(_ text: String) {
        autosaveTask?.cancel()
        autosaveTask = Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            await saveNote(text)
        }
    }

    private func saveNote(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, text != lastSavedText else { return }
        saveState = .saving
        do {
            let token = try await auth.getAccessTokenSilently()
            let createdAt = ISO8601DateFormatter().string(from: Date())
            let result = try await NotesService.saveNote(
                token: token,
                noteKey: activeNoteKey,
                noteValue: text,
                title: noteTitle ?? "",
                createdAt: createdAt
            )
            if let title = result.title, !title.isEmpty {
                noteTitle = title
            }
            lastSavedText = text
            isNewNote = false
            saveState = .saved(Date())
            await loadNotes()
        } catch {
            saveState = .retrying
            autosaveTask?.cancel()
            autosaveTask = Task {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !Task.isCancelled else { return }
                await saveNote(noteText)
            }
        }
    }
}
