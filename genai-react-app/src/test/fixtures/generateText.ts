import { AIVendor } from '../../constants/vendors';
import { GenerateTextRequest, GenerateTextResponse } from '../../models/generateText.models';

export const mockGenerateTextRequest: GenerateTextRequest = {
    conversationId: 'conv-123',
    client: 'REACT_APP',
    selectedResponseId: 'msg-prev',
    prompt: {
        instructionId: '',
        instructionVersion: '',
        prompt: 'Hello'
    },
    aiConfig: [
        {
            aiVendor: AIVendor.OPENAI,
            model: 'gpt-4'
        }
    ]
};

export const mockGenerateTextResponse: GenerateTextResponse = {
    text: 'Hello World',
    aiVendor: 'OPENAI',
    conversationId: 'conv-123',
    messageId: 'msg-abc'
};

export const mockGenerateTextStreamRequest = {
    conversationId: 'conv-123',
    client: 'REACT_APP',
    selectedResponseId: 'msg-prev',
    prompt: {
        instructionId: '',
        instructionVersion: '',
        prompt: 'Hello'
    },
    aiConfig: {
        aiVendor: AIVendor.OPENAI,
        model: 'gpt-4'
    }
};
