package service

import com.genflowly.models.api.CreateInstructionResponse

    suspend fun createInstruction(
        customerId: String,
        instructionName: String,
        instruction: String,
        existingInstructionId: String?,
    ): CreateInstructionResponse {
        var instructionId = existingInstructionId
        var version = 1

        if (instructionId != null) {
            val latestVersion = dynamoDBProvider.getLatestInstructionVersion(instructionId) ?: 0
            version = latestVersion + 1
        } else {
            instructionId = "INS-${UUID.randomUUID()}"
            version = 1
        }

        val newInstruction = models.Instruction(
            id = instructionId,
            creator = customerId,
            name = instructionName,
            instructions = instruction,
            version = version
        )

        dynamoDBProvider.saveInstruction(newInstruction)

        return CreateInstructionResponse(
            id = instructionId,
            version = version,
            instructionName = instructionName
        )
    }
}


fun generateCustomerId(): String {
    val uuid =
        UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "CU$uuid"
}
