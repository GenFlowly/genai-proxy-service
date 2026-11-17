import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import InstructionsPage from '../../../pages/InstructionsPage/InstructionsPage';
import { useAuth } from '../../../context/AuthContext';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();

jest.mock('react-router', () => ({
    ...jest.requireActual('react-router'),
    useNavigate: () => mockNavigate,
}));

jest.mock('../../../components/navbar/Navbar', () => () => <div data-testid="mock-navbar" />);

jest.mock('../../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}));

describe('InstructionsPage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders empty state when there are no instructions', () => {
        (useAuth as jest.Mock).mockReturnValue({
            customerInstructions: [],
            refreshInstructions: jest.fn(),
        });

        render(
            <MemoryRouter>
                <InstructionsPage />
            </MemoryRouter>
        );

        expect(screen.getByText('Instructions Hub')).toBeInTheDocument();
        expect(screen.getByText('No instructions found. Create one to get started!')).toBeInTheDocument();
    });

    test('renders tiles for unique latest versions of instructions', () => {
        const mockInstructions = [
            { id: 'inst-1', name: 'Persona A', instruction: 'Text A', version: 1 },
            { id: 'inst-1', name: 'Persona A updated', instruction: 'Text A+', version: 2 },
            { id: 'inst-2', name: 'Persona B', instruction: 'Text B', version: 1 },
        ];

        (useAuth as jest.Mock).mockReturnValue({
            customerInstructions: mockInstructions,
            refreshInstructions: jest.fn(),
        });

        render(
            <MemoryRouter>
                <InstructionsPage />
            </MemoryRouter>
        );

        // Should show latest of inst-1 and inst-2
        expect(screen.getByText('Persona A updated')).toBeInTheDocument();
        expect(screen.getByText('Persona B')).toBeInTheDocument();
        // Should NOT show old version
        expect(screen.queryByText('Persona A')).not.toBeInTheDocument();
    });

    test('filters instructions with the client-side search box', async () => {
        const mockInstructions = [
            { id: 'inst-1', name: 'Physics Tutor', instruction: 'Teach physics', version: 1 },
            { id: 'inst-2', name: 'Tax Advisor', instruction: 'Advise on taxes', version: 1 },
        ];

        (useAuth as jest.Mock).mockReturnValue({
            customerInstructions: mockInstructions,
            refreshInstructions: jest.fn(),
        });

        render(
            <MemoryRouter>
                <InstructionsPage />
            </MemoryRouter>
        );

        expect(screen.getByText('Physics Tutor')).toBeInTheDocument();
        expect(screen.getByText('Tax Advisor')).toBeInTheDocument();

        await userEvent.type(screen.getByPlaceholderText('Search instructions…'), 'physics');

        expect(screen.getByText('Physics Tutor')).toBeInTheDocument();
        expect(screen.queryByText('Tax Advisor')).not.toBeInTheDocument();
    });

    test('shows a no-results message when the search matches nothing', async () => {
        const mockInstructions = [
            { id: 'inst-1', name: 'Physics Tutor', instruction: 'Teach physics', version: 1 },
        ];

        (useAuth as jest.Mock).mockReturnValue({
            customerInstructions: mockInstructions,
            refreshInstructions: jest.fn(),
        });

        render(
            <MemoryRouter>
                <InstructionsPage />
            </MemoryRouter>
        );

        await userEvent.type(screen.getByPlaceholderText('Search instructions…'), 'zzz-no-match');

        expect(screen.getByText('No instructions match your search.')).toBeInTheDocument();
        expect(screen.queryByText('Physics Tutor')).not.toBeInTheDocument();
    });

    test('navigates to create new instruction when button clicked', async () => {
        (useAuth as jest.Mock).mockReturnValue({ customerInstructions: [], refreshInstructions: jest.fn() });

        render(
            <MemoryRouter>
                <InstructionsPage />
            </MemoryRouter>
        );

        const createButton = screen.getByText('Create Instruction');
        await userEvent.click(createButton);

        expect(mockNavigate).toHaveBeenCalledWith('/instructions/new');
    });
});
