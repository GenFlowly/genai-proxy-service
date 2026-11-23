import Foundation
import Testing
@testable import AI_Wrapper

// MARK: - Turn-level learned memory (Response.test.tsx "added to memory (one section per turn)")

@MainActor
struct TurnLearnedMemoryTests {
    private final class EmptyVault: TokenVault {
        func get(_ key: String) -> String? { nil }
        func set(_ value: String, for key: String) {}
        func delete(_ key: String) {}
    }

    private let auth = AuthStore(auth0: Auth0Service(vault: EmptyVault(), send: { _ in throw URLError(.notConnectedToInternet) }))

    private func fact(_ id: String, _ text: String) -> LearnedFact {
        LearnedFact(memoryId: id, text: text, kind: "CORE", runId: "RUN1")
    }

    private func reply(_ id: String, _ vendor: AIVendor = .openai, facts: LearnedFactsState, loading: Bool = false) -> Message {
        var message = Message(aiVendor: vendor, text: "answer", messageId: id)
        message.learnedFacts = facts
        message.isLoading = loading
        return message
    }

    @Test func aTurnStillStreamingShowsNothing() async {
        let memory = TurnLearnedMemory()
        await memory.update(conversationId: "C1", messages: [
            reply("m1", facts: .known([fact("MEM#1", "Is vegetarian.")])),
            reply("m2", .claude, facts: .fresh, loading: true),
        ], auth: auth)
        #expect(memory.status == .hidden)
    }

    @Test func everyResponseCarriesTheSameListSoTheTurnShowsItOnce() async {
        let facts = [fact("MEM#1", "Is vegetarian."), fact("MEM#2", "Runs every morning.")]
        let memory = TurnLearnedMemory()
        await memory.update(conversationId: "C1", messages: [
            reply("m1", facts: .known(facts)),
            reply("m2", .claude, facts: .known(facts)),
        ], auth: auth)
        #expect(memory.status == .done)
        #expect(memory.facts.map(\.memoryId) == ["MEM#1", "MEM#2"])
    }

    @Test func aResponseWithTheListWinsOverOneWithAnEmptyList() async {
        let memory = TurnLearnedMemory()
        await memory.update(conversationId: "C1", messages: [
            reply("m1", facts: .known([])),
            reply("m2", .claude, facts: .known([fact("MEM#9", "Plays the cello.")])),
        ], auth: auth)
        #expect(memory.status == .done)
        #expect(memory.facts.map(\.text) == ["Plays the cello."])
    }

    @Test func aTurnFromBeforeTheFeatureSaysNothingWasAdded() async {
        let memory = TurnLearnedMemory()
        await memory.update(conversationId: "C1", messages: [reply("m1", facts: .unknown)], auth: auth)
        #expect(memory.status == .done)
        #expect(memory.facts.isEmpty)
    }

    @Test func theTaskKeyChangesWhenTheTurnsOutcomeCould() {
        let streaming = TurnLearnedMemory.key(for: [reply("m1", facts: .fresh, loading: true)])
        let finished = TurnLearnedMemory.key(for: [reply("m1", facts: .fresh)])
        let learned = TurnLearnedMemory.key(for: [reply("m1", facts: .known([fact("MEM#1", "x")]))])
        let fewer = TurnLearnedMemory.key(for: [reply("m1", facts: .known([]))])
        #expect(Set([streaming, finished, learned, fewer]).count == 4)
    }
}

// MARK: - How it was inferred (MemoryInference.test.tsx, MemoryInferencePage.test.tsx)

struct MemoryInferenceDecodingTests {
    /// The shape GET /memories/{id}/inference/{runId} returns, trimmed from a live response.
    private let payload = """
    {
      "memory": {"memoryId": "MEM#1", "text": "Is 34 years old.", "kind": "CORE", "category": "profile",
                 "sourceType": "CONVERSATION", "sourceId": "C1", "createdAt": "2026-11-23T07:39:30Z",
                 "updatedAt": "2026-11-23T07:39:30Z", "placements": [{"projectId": null, "kind": "CORE"}],
                 "version": 1, "tracked": true, "hitCount": 3, "lastUsedAt": "2026-11-23T07:59:34Z"},
      "change": {"changeId": "MEMCHG#1#t#a", "type": "LEARNED", "createdAt": "2026-11-23T07:39:30Z", "version": 1,
                 "text": "Is 34 years old.", "previousText": null, "sourceType": "CONVERSATION", "conversationId": "C1",
                 "messageId": "U1", "noteKey": null, "reason": "User stated their age.", "from": null, "to": null,
                 "runId": "RUN1", "conversationTitle": null, "conversationAvailable": null, "youSaid": null},
      "run": {"runId": "RUN1", "source": "conversation", "conversationId": "C1", "projectId": null, "turnMessageId": "U1",
              "messageIds": ["U1", "R1"], "responsesRead": [{"messageId": "R1", "vendor": "OPENAI", "model": "gpt-5.4-nano"}],
              "existingShown": 7, "agentId": "A1", "agentVersion": null, "vendor": "OPENAI", "model": "gpt-5-mini",
              "startedAt": "2026-11-23T07:38:57Z", "durationMs": 34280, "inputTokens": 1746, "outputTokens": 2541,
              "costUsd": 0.0055,
              "operations": [
                {"op": "ADD", "memoryId": "MEM#1", "text": "Is 34 years old.", "reason": "User stated their age.",
                 "messageIndex": 1, "outcome": "applied", "memoryDeleted": false},
                {"op": "ADD", "memoryId": "MEM#2", "text": null, "reason": null,
                 "messageIndex": 1, "outcome": "applied", "memoryDeleted": true}
              ],
              "truncated": false},
      "excerpts": [
        {"messageId": "U1", "role": "user", "vendor": null, "index": 1, "text": "I'm 34 and vegetarian.", "taken": true},
        {"messageId": "R1", "role": "assistant", "vendor": "OPENAI", "index": 2, "text": "Here is a plan.", "taken": false}
      ],
      "conversationTitle": "Kyoto plan",
      "conversationDeleted": false
    }
    """

    @Test func theLiveShapeDecodes() throws {
        let inference = try JSONDecoder().decode(MemoryInference.self, from: Data(payload.utf8))
        #expect(inference.change?.runId == "RUN1")
        #expect(inference.run.responsesRead.map(\.vendor) == ["OPENAI"])
        #expect(inference.excerpts.first(where: \.taken)?.role == "user")
        #expect(inference.conversationTitle == "Kyoto plan")
    }

    @Test func aMemoryDeletedSinceKeepsNoWords() throws {
        let inference = try JSONDecoder().decode(MemoryInference.self, from: Data(payload.utf8))
        let gone = inference.run.operations[1]
        #expect(gone.memoryDeleted == true)
        #expect(gone.text == nil)
        #expect(gone.reason == nil)
        #expect(inference.run.operations[0].memoryDeleted == false)
    }

    @Test func anOperationFromBeforeTheFlagStillDecodes() throws {
        let old = payload.replacingOccurrences(of: ", \"memoryDeleted\": false", with: "")
        let inference = try JSONDecoder().decode(MemoryInference.self, from: Data(old.utf8))
        #expect(inference.run.operations[0].memoryDeleted == nil)
    }
}

// MARK: - Strings (en.json conversation.learnedMemory / memoryInference)

struct InferredMemoryStringTests {
    @Test func theSheetAndChipCountFacts() {
        #expect(L("conversation.learnedMemory.sheetTitle", ["count": 1]) == "1 fact added to memory")
        #expect(L("conversation.learnedMemory.sheetTitle", ["count": 4]) == "4 facts added to memory")
        #expect(L("conversation.learnedMemory.chipText", ["count": 1]) == "fact added to memory from this turn")
        #expect(L("conversation.learnedMemory.chipText", ["count": 2]) == "facts added to memory from this turn")
    }

    @Test func aRunWithNoChangesHasItsOwnSentence() {
        #expect(L("memoryInference.decidedNone") == "It proposed no changes.")
        #expect(L("memoryInference.decidedText", ["count": 1]) == "It proposed 1 change, with its own reason.")
        #expect(L("memoryInference.memoryDeleted") == "Memory deleted since")
    }
}
