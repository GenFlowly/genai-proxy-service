import { getConversation } from '../../services/conversationService';
import { generateText } from '../../services/generateTextService';
import { onboardCustomer } from '../../services/onboardUserService';
import { storeCustomerVectorDBConfig } from '../../services/storeCustomerVectorDBConfigService';
import { storeCustomerVendorApiKey } from '../../services/storeCustomerVendorApiKeysService';

// Global fetch mock
global.fetch = jest.fn();

describe('Service Layer Gaps', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('conversationService calls', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ promptAndResponseList: [] })
        });

        await getConversation('token', 'id');
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/v1/chat?conversationId=id'), expect.anything());
    });

    test('generateTextService calls', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ text: 'hi' })
        });

        await generateText('token', { prompt: { prompt: 'hi' } } as any);
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/generate'), expect.objectContaining({ method: 'POST' }));
    });

    test('onboardUserService calls', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ customerId: 'c1' })
        });

        await onboardCustomer({ sub: 's1' } as any, 'token');
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/onboard'), expect.anything());
    });

    test('vector and api key services', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ status: 'ok' })
        });

        await storeCustomerVectorDBConfig('token', { vendor: 'PINECONE' } as any);
        await storeCustomerVendorApiKey('token', { aiVendor: 'OPENAI' } as any);
        
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });
});
