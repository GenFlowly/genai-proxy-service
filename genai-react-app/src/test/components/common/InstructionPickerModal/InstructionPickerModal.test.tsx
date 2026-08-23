import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import InstructionPickerModal from '../../../../components/common/InstructionPickerModal/InstructionPickerModal';
import * as instructionService from '../../../../services/instructionService';

jest.mock('@auth0/auth0-react', () => ({
    useAuth0: () => ({
        getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token')
    })
}));
jest.mock('../../../../services/instructionService');

const mockGetRecent = instructionService.getRecentInstructions as jest.Mock;
const mockSearch = instructionService.searchInstructions as jest.Mock;

const recentInstruction = {
    id: 'inst-1', name: 'Physics Wave Expert', version: 3,
    instruction: 'You are an expert in physics.', icon: '🔍⚡', color: '#059669',
    tags: ['physics'], role: 'OWNER'
};
const searchedInstruction = {
    id: 'inst-2', name: 'H1B Tax Advisor', version: 1,
    instruction: 'You are an immigration and Tax expert.', role: 'OWNER'
};

describe('InstructionPickerModal', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetRecent.mockResolvedValue({ instructions: [recentInstruction] });
        mockSearch.mockResolvedValue({ instructions: [searchedInstruction] });
    });

    test('shows recently used instructions when opened', async () => {
        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        expect(await screen.findByText('Physics Wave Expert')).toBeInTheDocument();
        expect(screen.getByText('Recently used')).toBeInTheDocument();
        expect(mockGetRecent).toHaveBeenCalledWith('mock-token', 3);
    });

    test('searches the backend as the user types', async () => {
        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        await userEvent.type(screen.getByTestId('instruction-picker-search'), 'tax');

        expect(await screen.findByText('H1B Tax Advisor')).toBeInTheDocument();
        expect(screen.getByText('Search results')).toBeInTheDocument();
        await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('mock-token', 'tax'));
    });

    test('selecting a tile fires onSelect with the instruction', async () => {
        const onSelect = jest.fn();
        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={onSelect} />);

        await userEvent.click(await screen.findByTestId('instruction-picker-tile-inst-1'));
        expect(onSelect).toHaveBeenCalledWith(recentInstruction);
    });

    test('renders nothing when closed', () => {
        render(<InstructionPickerModal isOpen={false} onClose={jest.fn()} onSelect={jest.fn()} />);
        expect(screen.queryByText('Choose Instruction')).not.toBeInTheDocument();
        expect(mockGetRecent).not.toHaveBeenCalled();
    });
});
