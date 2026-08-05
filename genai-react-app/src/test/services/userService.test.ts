import { searchUserByUsername, getUserProfile, updateUsername, updateDiscoverability } from '../../services/userService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';

jest.mock('../../utils/apiUtils');

describe('userService', () => {
    const mockToken = 'test-token';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('searchUserByUsername', () => {
        it('returns user list on success', async () => {
            const mockResponse = [{ id: '1', username: 'testuser' }];
            (fetchWithRetry as jest.Mock).mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue(mockResponse),
            });

            const result = await searchUserByUsername(mockToken, 'testuser');
            expect(result).toEqual(mockResponse);
            expect(fetchWithRetry).toHaveBeenCalledWith(
                `${endpoints.searchUsers}?username=testuser`,
                expect.objectContaining({ method: 'GET' })
            );
        });

        it('returns empty array on error', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Server Error',
            });

            const result = await searchUserByUsername(mockToken, 'testuser');
            expect(result).toEqual([]);
        });
    });

    describe('getUserProfile', () => {
        it('returns profile on success', async () => {
            const mockProfile = { customerId: '123', username: 'testuser' };
            (fetchWithRetry as jest.Mock).mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue(mockProfile),
            });

            const result = await getUserProfile(mockToken);
            expect(result).toEqual(mockProfile);
        });

        it('returns null on error', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValue({ ok: false });
            const result = await getUserProfile(mockToken);
            expect(result).toBeNull();
        });
    });

    describe('updateUsername', () => {
        it('returns true on success', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValue({ ok: true });
            const result = await updateUsername(mockToken, 'newuser');
            expect(result).toBe(true);
        });

        it('throws error on 409 conflict', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValue({ ok: false, status: 409 });
            await expect(updateUsername(mockToken, 'newuser')).rejects.toThrow('Username is already taken');
        });

        it('throws error on other failures', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });
            await expect(updateUsername(mockToken, 'newuser')).rejects.toThrow('Update Username failed: 400 Bad Request');
        });
    });

    describe('updateDiscoverability', () => {
        it('returns true on success', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValue({ ok: true });
            const result = await updateDiscoverability(mockToken, true);
            expect(result).toBe(true);
        });

        it('returns false on error', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValue({ ok: false });
            const result = await updateDiscoverability(mockToken, false);
            expect(result).toBe(false);
        });
    });
});
