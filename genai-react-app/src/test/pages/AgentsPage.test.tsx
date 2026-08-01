import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentsPage from '../../pages/AgentsPage/AgentsPage';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

// Mock children
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('../../pages/AgentsPage/CreateAgentPanel/CreateAgentPanel', () => ({ onBack }: { onBack: () => void }) => (
    <div data-testid="create-agent-panel">
        CreateAgentPanel
        <button data-testid="back-button" onClick={onBack}>Back</button>
    </div>
));

// Mock LayoutContext
jest.mock('../../context/LayoutContext', () => ({
    useLayout: jest.fn()
}));
const { useLayout } = require('../../context/LayoutContext');

// Mock usePageTitle
jest.mock('../../hooks/usePageTitle', () => ({
    usePageTitle: jest.fn()
}));

describe('AgentsPage Component', () => {
    const mockSetLeftSidebarExpanded = jest.fn();
    const mockSetRightSidebarExpanded = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        useLayout.mockReturnValue({
            setLeftSidebarExpanded: mockSetLeftSidebarExpanded,
            setRightSidebarExpanded: mockSetRightSidebarExpanded
        });
    });

    test('renders navbar and empty state list view initially', () => {
        render(
            <MemoryRouter>
                <AgentsPage />
            </MemoryRouter>
        );

        expect(screen.getByTestId('navbar')).toBeInTheDocument();
        expect(screen.getByText('No agents yet')).toBeInTheDocument();
        expect(screen.getByText('+ Create Agent')).toBeInTheDocument();
        expect(screen.queryByTestId('create-agent-panel')).not.toBeInTheDocument();
    });

    test('collapses left and right sidebars on mount', () => {
        render(
            <MemoryRouter>
                <AgentsPage />
            </MemoryRouter>
        );

        expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(false);
        expect(mockSetRightSidebarExpanded).toHaveBeenCalledWith(false);
    });

    test('switches to create agent panel when + Create Agent button is clicked', async () => {
        render(
            <MemoryRouter>
                <AgentsPage />
            </MemoryRouter>
        );

        const createBtn = screen.getByText('+ Create Agent');
        await userEvent.click(createBtn);

        expect(screen.getByTestId('create-agent-panel')).toBeInTheDocument();
        expect(screen.queryByText('No agents yet')).not.toBeInTheDocument();
    });

    test('switches back to list view when back button is clicked in create agent panel', async () => {
        render(
            <MemoryRouter>
                <AgentsPage />
            </MemoryRouter>
        );

        await userEvent.click(screen.getByText('+ Create Agent'));
        expect(screen.getByTestId('create-agent-panel')).toBeInTheDocument();

        await userEvent.click(screen.getByTestId('back-button'));
        expect(screen.queryByTestId('create-agent-panel')).not.toBeInTheDocument();
        expect(screen.getByText('No agents yet')).toBeInTheDocument();
    });
});
