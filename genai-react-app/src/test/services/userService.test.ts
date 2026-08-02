import { searchUserByUsername, getUserProfile, updateUsername, updateDiscoverability } from '../../services/userService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';

jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('userService', () => {
    const mockToken = 'mock-auth-token';

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // 1. searchUserByUsername
    test('searchUserByUsername calls GET and returns array', async () => {
        const mockUsers = [{ customerId: 'c1', username: 'user1' }];
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockUsers)
        });

        const result = await searchUserByUsername(mockToken, 'user1');

        expect(mockFetchWithRetry).toHaveBeenCalledWith(`${endpoints.searchUsers}?username=user1`, {
            method: HttpMethod.GET,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${mockToken}`,
            },
        });
        expect(result).toEqual(mockUsers);
    });

    test('searchUserByUsername handles errors and returns empty array', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' });
        const result = await searchUserByUsername(mockToken, 'user1');
        expect(result).toEqual([]);
    });

    // 2. getUserProfile
    test('getUserProfile calls GET and returns profile', async () => {
        const mockProfile = { customerId: 'c1', username: 'user1', isDiscoverable: true };
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockProfile)
        });

        const result = await getUserProfile(mockToken);

        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.getProfile, {
            method: HttpMethod.GET,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${mockToken}`,
            },
        });
        expect(result).toEqual(mockProfile);
    });

    test('getUserProfile handles errors and returns null', async () => {
        mockFetchWithRetry.mockRejectedValue(new Error('Network Error'));
        const result = await getUserProfile(mockToken);
        expect(result).toBeNull();
    });

    // 3. updateUsername
    test('updateUsername calls POST and returns true', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true });

        const result = await updateUsername(mockToken, 'newuser');

        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.updateUsername, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${mockToken}`,
            },
            body: JSON.stringify({ username: 'newuser' })
        });
        expect(result).toBe(true);
    });

    test('updateUsername throws when username taken', async () => {
        mockFetchWithRetry.mockResolvedValue({ status: 409 });
        await expect(updateUsername(mockToken, 'newuser')).rejects.toThrow('Username is already taken');
    });

    test('updateUsername throws on general error', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
        await expect(updateUsername(mockToken, 'newuser')).rejects.toThrow('Update Username failed: 500 Server Error');
    });

    // 4. updateDiscoverability
    test('updateDiscoverability calls POST and returns true', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true });

        const result = await updateDiscoverability(mockToken, true);

        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.updateDiscoverability, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${mockToken}`,
            },
            body: JSON.stringify({ isDiscoverable: true })
        });
        expect(result).toBe(true);
    });

    test('updateDiscoverability handles errors and returns false', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });
        const result = await updateDiscoverability(mockToken, true);
        expect(result).toBe(false);
    });
});
