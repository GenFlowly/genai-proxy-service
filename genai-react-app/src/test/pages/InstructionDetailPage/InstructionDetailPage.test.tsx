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

describe('InstructionDetailPage', () => {
    const mockGetToken = jest.fn().mockResolvedValue('mock-token');
    const mockRefresh = jest.fn();
    const mockUpdate = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();

        (useAuth as jest.Mock).mockReturnValue({
            customerInstructions: [
                { id: 'inst-1', name: 'Existing', instruction: 'Original text', version: 1 }
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

        expect(screen.getByText('Share Options')).toBeInTheDocument();
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
});
