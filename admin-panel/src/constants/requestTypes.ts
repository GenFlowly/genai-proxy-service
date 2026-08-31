export enum RequestType {
    INSTRUCTION_PERSONA = 'INSTRUCTION_PERSONA',
    CONVERSATION_TITLE = 'CONVERSATION_TITLE',
    NOTE_TITLE = 'NOTE_TITLE',
    MEMORY_EXTRACTION = 'MEMORY_EXTRACTION',
}

export const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
    [RequestType.INSTRUCTION_PERSONA]: 'Instruction persona generation',
    [RequestType.CONVERSATION_TITLE]: 'Conversation title generation',
    [RequestType.NOTE_TITLE]: 'Note title generation',
    [RequestType.MEMORY_EXTRACTION]: 'User memory extraction',
}

/**
 * Template variables the backend supplies per request type. The prompt
 * template (system prompt instruction + agent input template) may only use
 * these — an unresolved {{placeholder}} fails the generation loudly.
 */
export const REQUEST_TYPE_VARIABLES: Record<RequestType, string[]> = {
    [RequestType.INSTRUCTION_PERSONA]: ['{{categoryJson}}', '{{instructionText}}'],
    [RequestType.CONVERSATION_TITLE]: ['{{instructionName}}', '{{prompt}}'],
    [RequestType.NOTE_TITLE]: ['{{noteContent}}'],
    [RequestType.MEMORY_EXTRACTION]: ['{{existingMemories}}', '{{sourceType}}', '{{content}}'],
}
