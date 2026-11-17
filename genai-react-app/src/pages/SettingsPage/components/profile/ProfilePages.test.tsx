import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountSettings } from './AccountSettings';
import { PrivacySettings } from './PrivacySettings';
import { BlockedUsersSettings } from './BlockedUsersSettings';
import { useAuth } from '../../../../context/AuthContext';
import { useToast } from '../../../../context/ToastContext';
import { getUserProfile, updateDiscoverability, updateUsername } from '../../../../services/userService';
import { getBlockedUsers } from '../../../../services/moderationService';
import { APIKeyStatus } from '../../../../models/storeCustomerVendorAPIKeys.models';
import { withQueryClient } from '../../../../test/utils/queryWrapper';
import { renderSettingsPage } from '../../settingsTestUtils';

jest.mock('../../../../context/AuthContext');
jest.mock('../../../../context/ToastContext');
jest.mock('../../../../services/userService');
jest.mock('../../../../services/moderationService');
jest.mock('../../../../components/common/BlockedUsersList/BlockedUsersList', () => ({
    BlockedUsersList: () => <div data-testid="blocked-users-list" />,
}));

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockGetUserProfile = getUserProfile as jest.Mock;
const mockUpdateUsername = updateUsername as jest.Mock;
const mockUpdateDiscoverability = updateDiscoverability as jest.Mock;
const mockGetBlockedUsers = getBlockedUsers as jest.Mock;

const PROFILE = { customerId: 'cust-1', username: 'nkrt', name: 'Steven Tester', email: 's@example.com', isDiscoverable: false };

describe('Profile pages', () => {
    const getAccessTokenSilently = jest.fn();
    const showToast = jest.fn();
    let seq = 0;
    const auth = (overrides: Record<string, unknown> = {}) => mockUseAuth.mockReturnValue({
        customerId: `cust-${seq}`,
        isAuthenticated: true,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList: [],
        aiDataConsentAt: null,
        ...overrides,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        seq += 1;
        getAccessTokenSilently.mockResolvedValue('tok');
        mockUseToast.mockReturnValue({ showToast });
        mockGetUserProfile.mockResolvedValue({ ...PROFILE, customerId: `cust-${seq}` });
        auth();
    });

    describe('Account', () => {
        test('shows the person, their initials and username, with no helper text in the cards', async () => {
            renderSettingsPage(withQueryClient(<AccountSettings />));

            expect(await screen.findByText('Steven Tester')).toBeInTheDocument();
            expect(screen.getByText('ST')).toBeInTheDocument();
            expect(screen.getByText('s@example.com')).toBeInTheDocument();
            expect(screen.getByTestId('username-input')).toHaveValue('nkrt');
            expect(screen.getByTestId('update-username')).toBeDisabled();
            expect(screen.getByText('Where this comes from')).toBeInTheDocument();
        });

        test('updates the username and says so', async () => {
            mockUpdateUsername.mockResolvedValue(undefined);
            renderSettingsPage(withQueryClient(<AccountSettings />));
            const input = await screen.findByTestId('username-input');

            await userEvent.clear(input);
            await userEvent.type(input, 'steven');
            await userEvent.click(screen.getByTestId('update-username'));

            await waitFor(() => expect(mockUpdateUsername).toHaveBeenCalledWith('tok', 'steven'));
            expect(showToast).toHaveBeenCalledWith('Username updated successfully!');
        });

        test('a refused username shows the reason and puts the old one back', async () => {
            mockUpdateUsername.mockRejectedValue(new Error('Username taken'));
            renderSettingsPage(withQueryClient(<AccountSettings />));
            const input = await screen.findByTestId('username-input');

            await userEvent.clear(input);
            await userEvent.type(input, 'taken');
            await userEvent.click(screen.getByTestId('update-username'));

            await waitFor(() => expect(showToast).toHaveBeenCalledWith('Username taken'));
            expect(input).toHaveValue('nkrt');
        });
    });

    describe('Privacy', () => {
        test('turning Discoverable on saves it', async () => {
            mockUpdateDiscoverability.mockResolvedValue(true);
            renderSettingsPage(withQueryClient(<PrivacySettings />));
            const toggle = screen.getByTestId('discoverable-switch');
            await waitFor(() => expect(toggle).toBeEnabled());

            await userEvent.click(toggle);

            await waitFor(() => expect(mockUpdateDiscoverability).toHaveBeenCalledWith('tok', true));
            expect(toggle).toHaveAttribute('aria-checked', 'true');
        });

        test('a failed save puts the switch back and says so', async () => {
            mockUpdateDiscoverability.mockResolvedValue(false);
            renderSettingsPage(withQueryClient(<PrivacySettings />));
            const toggle = screen.getByTestId('discoverable-switch');
            await waitFor(() => expect(toggle).toBeEnabled());

            await userEvent.click(toggle);

            await waitFor(() => expect(showToast).toHaveBeenCalled());
            expect(toggle).toHaveAttribute('aria-checked', 'false');
        });

        test('"How replies work" names no vendor or key wording for app-key users', async () => {
            auth({ aiDataConsentAt: '2026-11-01T10:00:00Z' });
            renderSettingsPage(withQueryClient(<PrivacySettings />));

            const card = screen.getByTestId('ai-data-sharing');
            expect(within(card).getByText(`You agreed on ${new Date('2026-11-01T10:00:00Z').toLocaleDateString()}.`)).toBeInTheDocument();
            expect(within(card).getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy-policy');
            expect(within(card).queryByText('Manage your connected services')).not.toBeInTheDocument();
            expect(card).not.toHaveTextContent(/BYOK|OpenAI|Anthropic|your provider|own key/i);
        });

        test('own-key users also get a link to their services', () => {
            auth({ aiVendorAPIKeyStatusList: [{ aiVendor: 'OPENAI', isAPIKeyValid: true, status: APIKeyStatus.VALID }] });
            renderSettingsPage(withQueryClient(<PrivacySettings />));

            expect(screen.getByRole('link', { name: 'Manage your connected services' })).toHaveAttribute('href', '/settings/byok/llm-keys');
        });
    });

    describe('Blocked users', () => {
        test('counts the people blocked and lists them', async () => {
            mockGetBlockedUsers.mockResolvedValue([{ customerId: 'a' }, { customerId: 'b' }]);
            renderSettingsPage(withQueryClient(<BlockedUsersSettings />));

            expect((await screen.findAllByText('2 blocked')).length).toBeGreaterThan(0);
            expect(screen.getByTestId('blocked-users-list')).toBeInTheDocument();
            expect(screen.getByRole('heading', { name: 'People you blocked' })).toBeInTheDocument();
        });
    });
});
