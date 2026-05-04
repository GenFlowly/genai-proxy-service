package com.genflowly.service

// RAG and response generation are now handled entirely by retrieval-server.
// This class is kept as a no-op to avoid restructuring injection across the codebase.
class PromptGenerationService {
    suspend fun generatePrompt(customerId: String, userRequestRawPrompt: String, systemPrompt: String?): String {
        return userRequestRawPrompt
    }
}
