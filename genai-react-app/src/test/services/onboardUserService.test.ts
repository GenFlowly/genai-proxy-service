import { onboardCustomer } from '../../services/onboardUserService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';
import { mockOnboardRequest, mockOnboardResponse } from '../fixtures/customerProfile';
import { User } from '@auth0/auth0-react'; // Or your local type if different

// Mock dependencies
jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('onboardUserService', () => {
    const mockToken = 'mock-auth-token';
    const mockUser: User = {
        sub: mockOnboardRequest.sub,
        email: mockOnboardRequest.email,
        name: mockOnboardRequest.name,
        picture: mockOnboardRequest.picture,
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('onboardCustomer calls POST with correct data and returns profile', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockOnboardResponse)
        });

        // Act
        const result = await onboardCustomer(mockUser, mockToken);

        // Assert
        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.onboardCustomer, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
            body: JSON.stringify({
                ...mockUser,
                client: 'REACT_APP'
            }),
        });

        expect(result).toEqual(mockOnboardResponse);
    });

    test('onboardCustomer throws error on failure', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error'
        });

        // Act & Assert
        await expect(onboardCustomer(mockUser, mockToken))
            .rejects.toThrow('Backend sync failed: 500 Internal Server Error');
    });
});
// Trigger coverage run
