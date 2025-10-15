package service

import repository.ApiKeyRepository

class ApiKeyService(
    private val repository: ApiKeyRepository = ApiKeyRepository()
) {
    fun saveApiKey(email: String, oidpProvider: String, apiKey: String) {
        // 📝 Add any business validation here if needed
        repository.saveApiKey(email, oidpProvider, apiKey)
    }
}
