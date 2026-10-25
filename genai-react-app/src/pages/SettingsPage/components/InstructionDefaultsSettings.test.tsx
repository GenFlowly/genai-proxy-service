import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstructionDefaultsSettings } from './InstructionDefaultsSettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/saveAIConfigService');

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockSave = saveAIConfigPreferences as jest.Mock;

const INSTRUCTIONS = [
    { id: 'inst-1', name: 'Support Agent', instruction: 'You are support', version: 1 },
    { id: 'inst-2', name: 'Sales Agent', instruction: 'You are sales', version: 2 },
];

describe('InstructionDefaultsSettings', () => {
    const mockShowToast = jest.fn();
    const mockGetToken = jest.fn();

    const authValue = (overrides: Record<string, any> = {}) => ({
        customerId: 'cust-1',
        isAuthenticated: true,
        getAccessTokenSilently: mockGetToken,
        aiConfigPreferences: null,
        customerInstructions: INSTRUCTIONS,
        ...overrides,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetToken.mockResolvedValue('test-token');
        mockUseToast.mockReturnValue({ showToast: mockShowToast });
        mockUseAuth.mockReturnValue(authValue());
        mockSave.mockResolvedValue(undefined);
    });

    test('renders the section (preferred mode by default shows the picker)', () => {
        render(<InstructionDefaultsSettings />);
        expect(screen.getByText('Default System Prompt / Instruction for Conversations')).toBeInTheDocument();
        expect(screen.getByText('Preferred instruction')).toBeInTheDocument();
        expect(screen.getByText('Save preferences')).toBeInTheDocument();
    });

    test('shows empty hint when the customer has no instructions', () => {
        mockUseAuth.mockReturnValue(authValue({ customerInstructions: [] }));
        render(<InstructionDefaultsSettings />);
        expect(screen.getByText('You have no instructions yet.')).toBeInTheDocument();
    });

    test('hides the preferred picker in last-used mode and saves mode only', async () => {
        mockUseAuth.mockReturnValue(authValue({
            aiConfigPreferences: { instructionFallbackMode: 'lastUsed' },
        }));
        render(<InstructionDefaultsSettings />);

        expect(screen.queryByText('Preferred instruction')).not.toBeInTheDocument();

        await userEvent.click(screen.getByText('Save preferences'));
        await waitFor(() => {
            expect(mockSave).toHaveBeenCalledWith('test-token', {
                aiConfigPreferences: { instructionFallbackMode: 'lastUsed' },
            });
            expect(mockShowToast).toHaveBeenCalledWith('Instruction preferences saved');
        });
    });

    test('saves the prefilled preferred instruction', async () => {
        mockUseAuth.mockReturnValue(authValue({
            aiConfigPreferences: { instructionFallbackMode: 'preferred', preferredInstructionId: 'inst-2' },
        }));
        render(<InstructionDefaultsSettings />);

        await userEvent.click(screen.getByText('Save preferences'));
        await waitFor(() => {
            expect(mockSave).toHaveBeenCalledWith('test-token', {
                aiConfigPreferences: { instructionFallbackMode: 'preferred', preferredInstructionId: 'inst-2' },
            });
        });
    });

    test('shows a toast and does not save when unauthenticated', async () => {
        mockUseAuth.mockReturnValue(authValue({ isAuthenticated: false, customerId: null }));
        render(<InstructionDefaultsSettings />);

        await userEvent.click(screen.getByText('Save preferences'));
        expect(mockShowToast).toHaveBeenCalledWith('Please log in first');
        expect(mockSave).not.toHaveBeenCalled();
    });

    test('surfaces a toast when saving fails', async () => {
        mockUseAuth.mockReturnValue(authValue({
            aiConfigPreferences: { instructionFallbackMode: 'preferred', preferredInstructionId: 'inst-1' },
        }));
        mockSave.mockRejectedValue(new Error('boom'));
        render(<InstructionDefaultsSettings />);

        await userEvent.click(screen.getByText('Save preferences'));
        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('boom');
        });
    });
});
