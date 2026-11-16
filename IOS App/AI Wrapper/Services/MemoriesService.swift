import Foundation

// MARK: - Memories (src/services/memoriesService.ts)

enum MemoriesService {
    /// "/api/v1/memories[/<id>[/<action>]]". Ids look like "MEM#<uuid>": the "#" must be
    /// percent-encoded, or the request stops at the fragment and reaches the wrong path.
    static func url(_ memoryId: String? = nil, _ action: String? = nil, query: [URLQueryItem] = []) -> URL {
        var path = AppConfig.backendBaseURL.absoluteString + "/api/v1/memories"
        if let memoryId {
            var allowed = CharacterSet.urlPathAllowed
            allowed.remove(charactersIn: "/#?")
            path += "/" + (memoryId.addingPercentEncoding(withAllowedCharacters: allowed) ?? memoryId)
        }
        if let action { path += "/" + action }
        var components = URLComponents(string: path)!
        if !query.isEmpty { components.queryItems = query }
        return components.url!
    }

    static func list(token: String) async throws -> [CustomerMemory] {
        try await APIClient.requestJSON(url(), token: token, as: GetMemoriesResponse.self).memories ?? []
    }

    static func detail(token: String, memoryId: String) async throws -> MemoryDetail {
        try await APIClient.requestJSON(url(memoryId), token: token, as: MemoryDetail.self)
    }

    static func usage(token: String, memoryId: String, cursor: String? = nil, limit: Int = 25) async throws -> MemoryUsagePage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await APIClient.requestJSON(url(memoryId, "usage", query: query), token: token, as: MemoryUsagePage.self)
    }

    private struct CreateBody: Encodable { let text: String; let kind: MemoryKind; let projectId: String? }
    private struct EditBody: Encodable { let text: String; let baseVersion: Int }
    private struct MoveBody: Encodable { let fromProjectId: String?; let toProjectId: String?; let kind: MemoryKind }
    private struct CopyBody: Encodable { let fromProjectId: String; let toProjectId: String; let kind: MemoryKind }

    static func create(token: String, text: String, kind: MemoryKind, projectId: String?) async throws -> CustomerMemory {
        try await APIClient.requestJSON(url(), method: .post, token: token, body: CreateBody(text: text, kind: kind, projectId: projectId), as: MemoryResponse.self).memory
    }

    /// Refused with 409 when a version newer than `baseVersion` exists.
    static func edit(token: String, memoryId: String, text: String, baseVersion: Int) async throws -> CustomerMemory {
        try await APIClient.requestJSON(url(memoryId), method: .put, token: token, body: EditBody(text: text, baseVersion: baseVersion), as: MemoryResponse.self).memory
    }

    static func move(token: String, memoryId: String, fromProjectId: String?, toProjectId: String?, kind: MemoryKind) async throws -> CustomerMemory {
        try await APIClient.requestJSON(url(memoryId, "move"), method: .post, token: token, body: MoveBody(fromProjectId: fromProjectId, toProjectId: toProjectId, kind: kind), as: MemoryResponse.self).memory
    }

    static func copy(token: String, memoryId: String, fromProjectId: String, toProjectId: String, kind: MemoryKind) async throws -> CustomerMemory {
        try await APIClient.requestJSON(url(memoryId, "copy"), method: .post, token: token, body: CopyBody(fromProjectId: fromProjectId, toProjectId: toProjectId, kind: kind), as: MemoryResponse.self).memory
    }

    /// True when the memory is gone; false when it only left `projectId`. A memory already
    /// gone counts as deleted.
    static func delete(token: String, memoryId: String, projectId: String? = nil) async throws -> Bool {
        let query = projectId.map { [URLQueryItem(name: "projectId", value: $0)] } ?? []
        do {
            let (data, _) = try await APIClient.request(url(memoryId, query: query), method: .delete, token: token)
            return (try? JSONDecoder().decode(DeleteMemoryResult.self, from: data))?.deleted ?? true
        } catch let error as APIError where error.status == 404 {
            return true
        }
    }

    static func deleteAll(token: String) async throws -> Int {
        let (data, _) = try await APIClient.request(url(), method: .delete, token: token)
        return (try? JSONDecoder().decode(DeleteAllMemoriesResult.self, from: data))?.deleted ?? 0
    }
}
