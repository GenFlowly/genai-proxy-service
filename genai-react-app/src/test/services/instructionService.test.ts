import { getCustomerInstructions, createInstruction, getInstructionVersion } from '../../services/instructionService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';
import {
    mockInstructionResponse,
    mockCustomerInstructionListResponse,
    mockCreateInstructionRequest,
    mockUpdateInstructionRequest
} from '../fixtures/instruction';

// Mock dependencies
jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('instructionService', () => {
    const mockToken = 'mock-auth-token';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    // 1. getCustomerInstructions
    test('getCustomerInstructions calls API and returns list', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockCustomerInstructionListResponse)
        });

        const result = await getCustomerInstructions(mockToken);

        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.getCustomerInstructions, {
            method: HttpMethod.GET,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
        });

        expect(result).toEqual(mockCustomerInstructionListResponse);
        expect(result.instructions).toHaveLength(2);
    });

    test('getCustomerInstructions throws error on failure', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 401,
            statusText: 'Unauthorized'
        });

        await expect(getCustomerInstructions(mockToken))
            .rejects.toThrow('Get Instructions failed: 401 Unauthorized');
    });

    // 2. createInstruction
    test('createInstruction calls POST and returns new instruction', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockInstructionResponse)
        });

        const result = await createInstruction(mockToken, mockCreateInstructionRequest);

        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.createInstruction, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
            body: JSON.stringify(mockCreateInstructionRequest)
        });

        expect(result).toEqual(mockInstructionResponse);
    });

    test('createInstruction calls POST (update scenario) and returns updated instruction', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockInstructionResponse)
        });

        await createInstruction(mockToken, mockUpdateInstructionRequest);

        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.createInstruction, {
            method: HttpMethod.POST,
            headers: expect.anything(),
            body: JSON.stringify(mockUpdateInstructionRequest)
        });
    });

    test('createInstruction throws error on failure', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Server Error'
        });

        await expect(createInstruction(mockToken, mockCreateInstructionRequest))
            .rejects.toThrow('Create Instruction failed: 500 Server Error');
    });

    // 3. getInstructionVersion
    test('getInstructionVersion calls GET with correct ID and Version', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockInstructionResponse)
        });

        const instructionId = 'INS-123';
        const version = 5;
        const expectedUrl = `${endpoints.createInstruction}/${instructionId}/${version}`;

        const result = await getInstructionVersion(mockToken, instructionId, version);

        expect(mockFetchWithRetry).toHaveBeenCalledWith(expectedUrl, {
            method: HttpMethod.GET,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
        });

        expect(result).toEqual(mockInstructionResponse);
    });

    test('getInstructionVersion throws error on failure', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 404,
            statusText: 'Not Found'
        });

        await expect(getInstructionVersion(mockToken, 'INS-999', 1))
            .rejects.toThrow('Get Instruction Version failed: 404 Not Found');
    });

    // 4. shareInstruction
    test('shareInstruction calls POST', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true });
        
        const { shareInstruction } = require('../../services/instructionService');
        await shareInstruction(mockToken, 'inst-1', 'cust-2', 'EDIT');
        
        expect(mockFetchWithRetry).toHaveBeenCalledWith(`${endpoints.createInstruction}/share`, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
            body: JSON.stringify({ instructionId: 'inst-1', targetCustomerId: 'cust-2', role: 'EDIT' }),
        });
    });

    test('shareInstruction throws error on failure', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
        const { shareInstruction } = require('../../services/instructionService');
        await expect(shareInstruction(mockToken, 'inst-1', 'cust-2')).rejects.toThrow('Share Instruction failed: 500 Server Error');
    });

    // 5. unshareInstruction
    test('unshareInstruction calls DELETE', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true });
        
        const { unshareInstruction } = require('../../services/instructionService');
        await unshareInstruction(mockToken, 'inst-1', 'cust-2');
        
        expect(mockFetchWithRetry).toHaveBeenCalledWith(`${endpoints.createInstruction}/share?instructionId=inst-1&targetCustomerId=cust-2`, {
            method: HttpMethod.DELETE,
            headers: expect.anything(),
        });
    });

    test('unshareInstruction throws error on failure', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
        const { unshareInstruction } = require('../../services/instructionService');
        await expect(unshareInstruction(mockToken, 'inst-1', 'cust-2')).rejects.toThrow('Unshare Instruction failed: 403 Forbidden');
    });

    // 6. deleteInstruction
    test('deleteInstruction calls DELETE', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true });
        
        const { deleteInstruction } = require('../../services/instructionService');
        await deleteInstruction(mockToken, 'inst-1');
        
        expect(mockFetchWithRetry).toHaveBeenCalledWith(`${endpoints.createInstruction}/inst-1`, {
            method: HttpMethod.DELETE,
            headers: expect.anything(),
        });
    });

    test('deleteInstruction throws error on failure', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });
        const { deleteInstruction } = require('../../services/instructionService');
        await expect(deleteInstruction(mockToken, 'inst-1')).rejects.toThrow('Delete Instruction failed: 400 Bad Request');
    });

    // 7. getInstructionSharedUsers
    test('getInstructionSharedUsers calls GET and returns users', async () => {
        const mockUsers = [{ customerId: 'c2', username: 'user2', role: 'VIEW' }];
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockUsers)
        });
        
        const { getInstructionSharedUsers } = require('../../services/instructionService');
        const result = await getInstructionSharedUsers(mockToken, 'inst-1');
        
        expect(mockFetchWithRetry).toHaveBeenCalledWith(`${endpoints.createInstruction}/inst-1/shared`, {
            method: HttpMethod.GET,
            headers: expect.anything(),
        });
        expect(result).toEqual(mockUsers);
    });

    test('getInstructionSharedUsers throws error on failure', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
        const { getInstructionSharedUsers } = require('../../services/instructionService');
        await expect(getInstructionSharedUsers(mockToken, 'inst-1')).rejects.toThrow('Get Shared Users failed: 404 Not Found');
    });
});
// trigger coverage run
