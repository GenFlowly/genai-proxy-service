import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteDataSettings } from './DeleteDataSettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { deleteAccount, deleteAllCredentials } from '../../../services/accountService';
import { deleteAllMemoryFacts } from '../../../services/learnedFactsService';
import { deleteIndexedChats } from '../../../services/chatIndexingService';
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models';
import { renderSettingsPage } from '../settingsTestUtils';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/accountService', () => ({
    ...jest.requireActual('../../../services/accountService'),
    deleteAccount: jest.fn(),
    deleteAllCredentials: jest.fn(),
}));
jest.mock('../../../services/learnedFactsService');
jest.mock('../../../services/chatIndexingService');

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockDeleteAccount = deleteAccount as jest.Mock;
const mockDeleteAllCredentials = deleteAllCredentials as jest.Mock;
const mockDeleteFacts = deleteAllMemoryFacts as jest.Mock;
const mockDeleteIndex = deleteIndexedChats as jest.Mock;

const OWN_KEY = [{ aiVendor: 'OPENAI', isAPIKeyValid: true, status: APIKeyStatus.VALID }];

describe('DeleteDataSettings', () => {
    const getAccessTokenSilently = jest.fn();
    const logout = jest.fn();
    const resyncAccount = jest.fn();
    const showToast = jest.fn();
    const auth = (overrides: Record<string, unknown> = {}) => mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        getAccessTokenSilently,
        logout,
        resyncAccount,
        aiVendorAPIKeyStatusList: OWN_KEY,
        ...overrides,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        getAccessTokenSilently.mockResolvedValue('tok');
        auth();
        mockUseToast.mockReturnValue({ showToast });
    });

    test('every delete lives here: facts, index, keys and account', () => {
        renderSettingsPage(<DeleteDataSettings />);

        expect(screen.getByRole('heading', { level: 1, name: 'Delete your data' })).toBeInTheDocument();
        expect(screen.getByTestId('delete-facts-button')).toBeInTheDocument();
        expect(screen.getByTestId('delete-index-button')).toBeInTheDocument();
        expect(screen.getByTestId('delete-keys-button')).toBeInTheDocument();
        expect(screen.getByTestId('delete-account-button')).toBeInTheDocument();
    });

    test('app-key users see no keys card and no key or database lines', () => {
        auth({ aiVendorAPIKeyStatusList: [] });
        renderSettingsPage(<DeleteDataSettings />);

        expect(screen.queryByTestId('delete-keys-button')).not.toBeInTheDocument();
        expect(screen.queryByText('Your API keys and connections.')).not.toBeInTheDocument();
        expect(screen.queryByText('At your AI providers')).not.toBeInTheDocument();
        expect(screen.queryByText(/BYOK/)).not.toBeInTheDocument();
    });

    describe('learned facts', () => {
        test('asks first, then deletes and reports the count', async () => {
            mockDeleteFacts.mockResolvedValue(4);
            renderSettingsPage(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-facts-button'));
            expect(screen.getByRole('heading', { name: 'Delete all learned facts?' })).toBeInTheDocument();
            expect(mockDeleteFacts).not.toHaveBeenCalled();

            await userEvent.click(screen.getByTestId('delete-facts-confirm'));

            await waitFor(() => expect(mockDeleteFacts).toHaveBeenCalledWith('tok'));
            await waitFor(() => expect(showToast).toHaveBeenCalledWith('Deleted 4 learned facts.'));
            expect(screen.queryByRole('heading', { name: 'Delete all learned facts?' })).not.toBeInTheDocument();
        });

        test('a failure keeps the dialog open with an error', async () => {
            mockDeleteFacts.mockRejectedValue(new Error('boom'));
            renderSettingsPage(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-facts-button'));
            await userEvent.click(screen.getByTestId('delete-facts-confirm'));

            expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't delete learned facts. Please try again.");
            expect(screen.getByRole('heading', { name: 'Delete all learned facts?' })).toBeInTheDocument();
        });
    });

    test('indexed chats: asks first, then deletes', async () => {
        mockDeleteIndex.mockResolvedValue(undefined);
        renderSettingsPage(<DeleteDataSettings />);

        await userEvent.click(screen.getByTestId('delete-index-button'));
        await userEvent.click(screen.getByTestId('delete-index-confirm'));

        await waitFor(() => expect(mockDeleteIndex).toHaveBeenCalledWith('tok'));
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Indexed chats deleted.'));
    });

    describe('keys and connections', () => {
        test('asks first, then deletes, refreshes the key statuses and reports the count', async () => {
            mockDeleteAllCredentials.mockResolvedValue(3);
            renderSettingsPage(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-keys-button'));
            expect(screen.getByRole('heading', { name: 'Delete all API keys?' })).toBeInTheDocument();
            await userEvent.click(screen.getByTestId('delete-keys-confirm'));

            await waitFor(() => expect(mockDeleteAllCredentials).toHaveBeenCalledWith('tok'));
            expect(resyncAccount).toHaveBeenCalled();
            await waitFor(() => expect(showToast).toHaveBeenCalledWith('Deleted 3 keys.'));
        });

        test('says so when there was nothing to delete', async () => {
            mockDeleteAllCredentials.mockResolvedValue(0);
            renderSettingsPage(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-keys-button'));
            await userEvent.click(screen.getByTestId('delete-keys-confirm'));

            await waitFor(() => expect(showToast).toHaveBeenCalledWith('There were no keys to delete.'));
        });

        test('cancel closes the dialog without deleting', async () => {
            renderSettingsPage(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-keys-button'));
            await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

            expect(screen.queryByRole('heading', { name: 'Delete all API keys?' })).not.toBeInTheDocument();
            expect(mockDeleteAllCredentials).not.toHaveBeenCalled();
        });

        test('signed out, nothing is deleted', async () => {
            auth({ isAuthenticated: false });
            renderSettingsPage(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-keys-button'));
            await userEvent.click(screen.getByTestId('delete-keys-confirm'));

            expect(await screen.findByRole('alert')).toBeInTheDocument();
            expect(mockDeleteAllCredentials).not.toHaveBeenCalled();
        });
    });

    describe('account', () => {
        const openAccountDialog = async () => {
            await userEvent.click(screen.getByTestId('delete-account-button'));
            return screen.getByTestId('delete-account-dialog-input');
        };

        test('needs DELETE typed before it can run', async () => {
            renderSettingsPage(<DeleteDataSettings />);
            const input = await openAccountDialog();

            expect(screen.getByTestId('delete-account-dialog-confirm')).toBeDisabled();
            await userEvent.type(input, 'delete');
            expect(screen.getByTestId('delete-account-dialog-confirm')).toBeDisabled();
            await userEvent.clear(input);
            await userEvent.type(input, 'DELETE');
            expect(screen.getByTestId('delete-account-dialog-confirm')).toBeEnabled();
            expect(mockDeleteAccount).not.toHaveBeenCalled();
        });

        test('a confirmed deletion signs the user out', async () => {
            mockDeleteAccount.mockResolvedValue(undefined);
            renderSettingsPage(<DeleteDataSettings />);
            await userEvent.type(await openAccountDialog(), 'DELETE');

            await userEvent.click(screen.getByTestId('delete-account-dialog-confirm'));

            await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledWith('tok'));
            expect(logout).toHaveBeenCalledWith({ returnTo: window.location.origin });
        });

        test('a failure keeps the user signed in with an error', async () => {
            mockDeleteAccount.mockRejectedValue(new Error('boom'));
            renderSettingsPage(<DeleteDataSettings />);
            await userEvent.type(await openAccountDialog(), 'DELETE');

            await userEvent.click(screen.getByTestId('delete-account-dialog-confirm'));

            expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't delete your account. Please try again.");
            expect(logout).not.toHaveBeenCalled();
        });
    });
});
