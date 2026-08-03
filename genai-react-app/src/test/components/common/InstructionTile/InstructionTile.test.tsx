import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { InstructionTile } from '../../../../components/common/InstructionTile/InstructionTile';
import { InstructionResponse } from '../../../../models/instruction.models';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

describe('InstructionTile', () => {
    const mockInstruction: InstructionResponse = {
        id: 'inst-1',
        name: 'Test Persona',
        instruction: 'You are a helpful assistant. '.repeat(10), // ~280 chars
        version: 2
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders instruction details correctly', () => {
        render(
            <MemoryRouter>
                <InstructionTile instruction={mockInstruction} />
            </MemoryRouter>
        );

        expect(screen.getByText('Test Persona')).toBeInTheDocument();
        expect(screen.getByText('v2')).toBeInTheDocument();
        
        // Should truncate the text to 140 chars + '...'
        const expectedTruncatedText = mockInstruction.instruction.substring(0, 140) + '...';
        expect(screen.getByText(expectedTruncatedText)).toBeInTheDocument();
    });

    test('navigates to details page on click', async () => {
        render(
            <MemoryRouter>
                <InstructionTile instruction={mockInstruction} />
            </MemoryRouter>
        );

        const tile = screen.getByTestId('instruction-tile-inst-1');
        await userEvent.click(tile);

        expect(mockNavigate).toHaveBeenCalledWith('/instructions/inst-1');
    });

    test('handles empty instruction text gracefully', () => {
        const emptyInstruction = { ...mockInstruction, instruction: '', name: '' };
        render(
            <MemoryRouter>
                <InstructionTile instruction={emptyInstruction} />
            </MemoryRouter>
        );

        expect(screen.getByText('Untitled Instruction')).toBeInTheDocument();
    });
});
