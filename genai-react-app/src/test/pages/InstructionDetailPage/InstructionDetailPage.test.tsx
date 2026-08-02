import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import InstructionDetailPage from '../../../pages/InstructionDetailPage/InstructionDetailPage';
import { useAuth } from '../../../context/AuthContext';
import { useAuth0 } from '@auth0/auth0-react';
import userEvent from '@testing-library/user-event';
import * as instructionService from '../../../services/instructionService';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

jest.mock('../../../components/navbar/Navbar', () => () => <div data-testid="mock-navbar" />);

jest.mock('../../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}));

jest.mock('@auth0/auth0-react', () => ({
    useAuth0: () => ({
        getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token')
    })
}));

// Mock the PromptEditor since it relies on UIW Markdown editor which can be tricky in JSDOM
jest.mock('../../../components/widgets/PromptEditorWidget/PromptEditor', () => {
    return function MockPromptEditor(props: any) {
        return (
            <textarea
                data-testid="mock-prompt-editor"
                value={props.value}
                onChange={(e) => props.onChange(e.target.value)}
            />
        );
    };
});

jest.mock('../../../components/common/ShareModal/ShareModal', () => {
    const React = require('react');
    return function MockShareModal(props: any) {
        if (!props.isOpen) return null;
        return (
            <div data-testid="mock-share-modal">
                <button onClick={() => props.onSave('PUBLIC', [], [])}>Make public to everyone</button>
                <button 
                    data-testid="mock-share-save" 
                    onClick={() => props.onSave('SPECIFIC', [{ customerId: 'c1', role: 'VIEW' }], [{ customerId: 'c2' }])}
                >
                    Save
                </button>
            </div>
        );
    };
});

describe('InstructionDetailPage', () => {
    const mockGetToken = jest.fn().mockResolvedValue('mock-token');
    const mockRefresh = jest.fn();
    const mockUpdate = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();

        (useAuth as jest.Mock).mockReturnValue({
            customerInstructions: [
                { id: 'inst-1', name: 'Existing', instruction: 'Original text', version: 1, role: 'OWNER' }
            ],
            refreshInstructions: mockRefresh,
            updateInstruction: mockUpdate
        });

        jest.spyOn(instructionService, 'createInstruction').mockResolvedValue({
            id: 'inst-1',
            name: 'Updated',
            instruction: 'New text',
            version: 2
        });
        jest.spyOn(instructionService, 'shareInstruction').mockResolvedValue(undefined);
        jest.spyOn(instructionService, 'deleteInstruction').mockResolvedValue(undefined);
        jest.spyOn(window, 'alert').mockImplementation(() => {});
        jest.spyOn(window, 'confirm').mockImplementation(() => true);
        jest.spyOn(window, 'prompt').mockImplementation(() => 'target-123');
    });

    const renderWithRoute = (initialRoute: string) => {
        render(
            <MemoryRouter initialEntries={[initialRoute]}>
                <Routes>
                    <Route path="/instructions/:instructionId" element={<InstructionDetailPage />} />
                </Routes>
            </MemoryRouter>
        );
    };

    test('loads existing instruction data when ID is provided', () => {
        renderWithRoute('/instructions/inst-1');
        
        expect(screen.getByText('Edit Instruction')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Existing')).toBeInTheDocument();
        expect(screen.getByTestId('mock-prompt-editor')).toHaveValue('Original text');
    });

    test('renders new instruction form when ID is "new"', () => {
        renderWithRoute('/instructions/new');
        
        expect(screen.getByText('Create Instruction')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('e.g., Code Reviewer Persona')).toHaveValue('');
        expect(screen.getByTestId('mock-prompt-editor')).toHaveValue('');
        // Share and Delete should not be present
        expect(screen.queryByText('Share')).not.toBeInTheDocument();
        expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    test('saves instruction and calls API', async () => {
        renderWithRoute('/instructions/new');
        
        const editor = screen.getByTestId('mock-prompt-editor');
        await userEvent.type(editor, 'My new prompt');
        
        const nameInput = screen.getByPlaceholderText('e.g., Code Reviewer Persona');
        await userEvent.type(nameInput, 'New Name');

        const saveButton = screen.getByText('Save');
        await userEvent.click(saveButton);

        await waitFor(() => {
            expect(instructionService.createInstruction).toHaveBeenCalledWith('mock-token', {
                instruction: 'My new prompt',
                instructionName: 'New Name',
                existingInstructionId: undefined
            });
            expect(mockUpdate).toHaveBeenCalled();
            expect(mockRefresh).toHaveBeenCalled();
        });
    });

    test('shares instruction when share button clicked', async () => {
        renderWithRoute('/instructions/inst-1');
        
        const shareButton = screen.getByText('Share');
        await userEvent.click(shareButton);

        expect(screen.getByTestId('mock-share-modal')).toBeInTheDocument();
    });

    test('deletes instruction and navigates away', async () => {
        renderWithRoute('/instructions/inst-1');
        
        const deleteButton = screen.getByText('Delete');
        await userEvent.click(deleteButton);

        expect(window.confirm).toHaveBeenCalled();
        await waitFor(() => {
            expect(instructionService.deleteInstruction).toHaveBeenCalledWith('mock-token', 'inst-1');
            expect(mockRefresh).toHaveBeenCalled();
            expect(mockNavigate).toHaveBeenCalledWith('/instructions');
        });
    });

    test('handles save instruction failure', async () => {
        jest.spyOn(instructionService, 'createInstruction').mockRejectedValueOnce(new Error('Save failed'));
        renderWithRoute('/instructions/new');
        
        const editor = screen.getByTestId('mock-prompt-editor');
        await userEvent.type(editor, 'My new prompt');
        
        const saveButton = screen.getByText('Save');
        await userEvent.click(saveButton);
        
        await waitFor(() => {
            expect(window.alert).toHaveBeenCalledWith('Failed to save instruction');
        });
    });

    test('handles delete instruction failure', async () => {
        jest.spyOn(instructionService, 'deleteInstruction').mockRejectedValueOnce(new Error('Delete failed'));
        renderWithRoute('/instructions/inst-1');
        
        const deleteButton = screen.getByText('Delete');
        await userEvent.click(deleteButton);
        
        await waitFor(() => {
            expect(window.alert).toHaveBeenCalledWith('Failed to delete instruction. You can only delete instructions you own.');
        });
    });

    test('back button navigates to instructions list', async () => {
        renderWithRoute('/instructions/inst-1');
        
        const backButton = screen.getByText('← Back');
        await userEvent.click(backButton);
        
        expect(mockNavigate).toHaveBeenCalledWith('/instructions');
    });

    test('ShareModal PUBLIC/PRIVATE mode shows alert', async () => {
        renderWithRoute('/instructions/inst-1');
        
        const shareButton = screen.getByText('Share');
        await userEvent.click(shareButton);
        
        const publicButton = screen.getByText('Make public to everyone');
        await userEvent.click(publicButton);
        
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("Backend currently doesn't support PUBLIC mode"));
    });

    test('ShareModal SPECIFIC mode saves successfully', async () => {
        jest.spyOn(instructionService, 'shareInstruction').mockResolvedValue(undefined);
        jest.spyOn(instructionService, 'unshareInstruction').mockResolvedValue(undefined);
        renderWithRoute('/instructions/inst-1');
        
        const shareButton = screen.getByText('Share');
        await userEvent.click(shareButton);
        
        // Find the mocked ShareModal and its save trigger
        const mockSaveButton = screen.getByTestId('mock-share-save');
        await userEvent.click(mockSaveButton);
        
        await waitFor(() => {
            expect(instructionService.shareInstruction).toHaveBeenCalledWith('mock-token', 'inst-1', 'c1', 'VIEW');
            expect(instructionService.unshareInstruction).toHaveBeenCalledWith('mock-token', 'inst-1', 'c2');
            expect(window.alert).toHaveBeenCalledWith('Instruction share settings updated successfully!');
        });
    });

    test('ShareModal SPECIFIC mode handles save failure', async () => {
        jest.spyOn(instructionService, 'shareInstruction').mockRejectedValue(new Error('Failed'));
        renderWithRoute('/instructions/inst-1');
        
        const shareButton = screen.getByText('Share');
        await userEvent.click(shareButton);
        
        const mockSaveButton = screen.getByTestId('mock-share-save');
        await userEvent.click(mockSaveButton);
        
        await waitFor(() => {
            expect(window.alert).toHaveBeenCalledWith('Failed to share instruction. Make sure you own it.');
        });
    });
});
