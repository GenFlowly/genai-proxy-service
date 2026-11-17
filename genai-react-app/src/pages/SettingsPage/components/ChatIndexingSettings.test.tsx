import React from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatIndexingSettings } from './ChatIndexingSettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService';
import { getEmbeddingKeys } from '../../../services/embeddingKeysService';
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models';
import { VectorDBConfigStatusValue } from '../../../models/storeCustomerVectorDBConfig.models';
import { getAiPreferences, mergeAiPreferences, replaceAiPreferences } from '../../../stores/aiPreferencesStore';
import { renderSettingsPage } from '../settingsTestUtils';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/saveAIConfigService');
jest.mock('../../../services/embeddingKeysService', () => ({
    ...jest.requireActual('../../../services/embeddingKeysService'),
    getEmbeddingKeys: jest.fn(),
}));

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockSave = saveAIConfigPreferences as jest.Mock;
const mockGetEmbeddingKeys = getEmbeddingKeys as jest.Mock;

const indexSwitch = () => screen.getByTestId('chat-indexing-switch');
const OWN_KEY = [{ aiVendor: 'OPENAI', isAPIKeyValid: true, status: APIKeyStatus.VALID }];

describe('ChatIndexingSettings', () => {
    const showToast = jest.fn();
    const getAccessTokenSilently = jest.fn();
    const auth = (overrides: Record<string, unknown> = {}) => mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList: [],
        vectorDBConfigStatusList: [],
        ...overrides,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        replaceAiPreferences('CU-test', {});
        getAccessTokenSilently.mockResolvedValue('tok');
        auth();
        mockUseToast.mockReturnValue({ showToast });
        mockGetEmbeddingKeys.mockResolvedValue({ statuses: [] });
        // The real service writes the store on success; mirror that here
        mockSave.mockImplementation(async (_token: string, payload: any) => {
            mergeAiPreferences(payload.aiConfigPreferences);
        });
    });

    test('indexing is off until the user turns it on', () => {
        renderSettingsPage(<ChatIndexingSettings />);

        expect(indexSwitch()).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByRole('heading', { level: 1, name: 'Search index' })).toBeInTheDocument();
        expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
    });

    test('turning it on saves the setting straight away', async () => {
        renderSettingsPage(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());

        await waitFor(() => expect(mockSave).toHaveBeenCalledWith('tok', { aiConfigPreferences: { indexChats: true } }));
        await waitFor(() => expect(indexSwitch()).toHaveAttribute('aria-checked', 'true'));
        expect(getAiPreferences()?.indexChats).toBe(true);
    });

    test('turning it off saves straight away, with no delete dialog', async () => {
        act(() => { replaceAiPreferences('CU1', { indexChats: true }); });
        renderSettingsPage(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());

        await waitFor(() => expect(mockSave).toHaveBeenCalledWith('tok', { aiConfigPreferences: { indexChats: false } }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByText(/delete/i)).not.toBeInTheDocument();
    });

    test('a failed save shows the error and puts the switch back', async () => {
        mockSave.mockRejectedValue(new Error('Network down'));
        renderSettingsPage(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Network down'));
        expect(indexSwitch()).toHaveAttribute('aria-checked', 'false');
        expect(indexSwitch()).not.toBeDisabled();
    });

    test('asks to log in instead of saving when signed out', async () => {
        auth({ isAuthenticated: false });
        renderSettingsPage(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());

        expect(showToast).toHaveBeenCalled();
        expect(mockSave).not.toHaveBeenCalled();
    });

    test('app-key users see no requirements and no key lookup', () => {
        renderSettingsPage(<ChatIndexingSettings />);

        expect(screen.queryByTestId('search-index-requirements')).not.toBeInTheDocument();
        expect(screen.queryByText('What it needs')).not.toBeInTheDocument();
        expect(mockGetEmbeddingKeys).not.toHaveBeenCalled();
    });

    test('own-key users see what is ready and a Set up link for what is missing', async () => {
        auth({ aiVendorAPIKeyStatusList: OWN_KEY });
        mockGetEmbeddingKeys.mockResolvedValue({
            statuses: [{ vendor: 'VOYAGE', isAPIKeyValid: true, status: APIKeyStatus.VALID }],
        });
        renderSettingsPage(<ChatIndexingSettings />);

        const row = screen.getByTestId('search-index-requirements');
        expect(within(row).getByText('Database · not set up')).toBeInTheDocument();
        expect(await within(row).findByText('Search key · ready')).toBeInTheDocument();
        expect(within(row).getByRole('link', { name: 'Set up' })).toHaveAttribute('href', '/settings/byok/vector-db');
    });

    test('with everything ready there is no Set up link', async () => {
        auth({
            aiVendorAPIKeyStatusList: OWN_KEY,
            vectorDBConfigStatusList: [{ vendor: 'Zilliz', isConfigValid: true, status: VectorDBConfigStatusValue.PRESENT, updateSuccessful: true }],
        });
        mockGetEmbeddingKeys.mockResolvedValue({
            statuses: [{ vendor: 'OPENAI', isAPIKeyValid: true, status: APIKeyStatus.VALID }],
        });
        renderSettingsPage(<ChatIndexingSettings />);

        const row = screen.getByTestId('search-index-requirements');
        expect(await within(row).findByText('Search key · ready')).toBeInTheDocument();
        expect(within(row).getByText('Database · ready')).toBeInTheDocument();
        expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    });

    test('the model row shows the platform default until one is chosen, then the chosen model', () => {
        const { unmount } = renderSettingsPage(<ChatIndexingSettings />);
        expect(screen.getByText('voyage-4-large · platform default')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Change' })).toHaveAttribute('href', '/settings/defaults/embedding-models');
        unmount();

        act(() => { replaceAiPreferences('CU1', { embeddingModelConversations: 'text-embedding-3-large' }); });
        renderSettingsPage(<ChatIndexingSettings />);
        expect(screen.getByText('text-embedding-3-large')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Details' })).toBeInTheDocument();
    });
});
