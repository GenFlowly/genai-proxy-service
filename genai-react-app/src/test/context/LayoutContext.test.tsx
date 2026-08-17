import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { LayoutProvider, useLayout } from '../../context/LayoutContext';
import { AuthProvider } from '../../context/AuthContext';
import { AIProvider } from '../../context/AIContext';
import { ConversationProvider } from '../../context/ConversationContext';
import { ToastProvider } from '../../context/ToastContext';
import LeftSidebar from '../../components/sections/LeftSidebar/LeftSidebar';
import RightSidebar from '../../components/sections/RightSidebar/RightSidebar';
import InstructionSidebarWidget from '../../components/widgets/SidebarWidgets/InstructionSidebarWidget/InstructionSidebarWidget';
import InstructionWidget from '../../components/widgets/InstructionWidget/InstructionWidget';
import { MemoryRouter } from 'react-router-dom';

// Mock child widgets to avoid deep rendering complexity
jest.mock('../../components/widgets/SidebarWidgets/ThreadWidget/ThreadWidget', () => () => <div data-testid="thread-widget">ThreadWidget</div>);
jest.mock('../../components/widgets/SidebarWidgets/NewChatWidget/NewChatWidget', () => () => <div>NewChatWidget</div>);
jest.mock('../../components/widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget', () => () => <div>AIVendorWidget</div>);
jest.mock('../../components/widgets/SidebarWidgets/TokenCounter/TokenCounter', () => () => <div>TokenCounter</div>);
// Mock TextEditor to avoid CodeMirror issues
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    TextEditor: () => <div data-testid="mock-text-editor">TextEditor</div>,
}));

// Mock other contexts that components might need
const mockUseAuth = jest.fn();
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => mockUseAuth(),
    AuthProvider: ({ children }: any) => children
}));

// Mock AIContext
jest.mock('../../context/AIContext', () => ({
    useAI: () => ({
        systemPrompt: 'Sys Prompt',
        setSystemPrompt: jest.fn(),
        selectedInstructionId: null,
        setSelectedInstructionId: jest.fn(),
    }),
    AIProvider: ({ children }: any) => children
}));

// Mock ConversationContext
jest.mock('../../context/ConversationContext', () => ({
    useConversation: () => ({ conversationBlockList: [] }),
    ConversationProvider: ({ children }: any) => children
}));


const customRender = (ui: React.ReactElement) => {
    return render(
        <MemoryRouter>
            <ToastProvider>
                <LayoutProvider>
                    <AuthProvider>
                        <AIProvider>
                            <ConversationProvider>
                                {ui}
                            </ConversationProvider>
                        </AIProvider>
                    </AuthProvider>
                </LayoutProvider>
            </ToastProvider>
        </MemoryRouter>
    );
};

// Helper component to verify context state
const LayoutStateTester = () => {
    const { isRightSidebarExpanded } = useLayout();
    return <div data-testid="layout-state">{isRightSidebarExpanded ? 'expanded' : 'collapsed'}</div>;
};

describe('LayoutContext UI Integration', () => {
    beforeEach(() => {
        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            aiVendorAPIKeyStatusList: [],
            customerInstructions: [],
            refreshInstructions: jest.fn(),
            updateInstruction: jest.fn(),
        });
    });

    test('useLayout throws error when used outside provider', () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        const TestThrow = () => {
            useLayout();
            return null;
        };
        expect(() => render(<TestThrow />)).toThrow('useLayout must be used within a LayoutProvider');
        consoleSpy.mockRestore();
    });

    test('RightSidebar toggles correctly', () => {
        customRender(<RightSidebar widgetIds={[]} />);

        const sidebar = screen.getByTestId('right-sidebar');
        const toggleBtn = screen.getByTestId('right-sidebar-toggle');

        expect(sidebar.className).not.toContain('collapsed');

        fireEvent.click(toggleBtn);
        expect(sidebar.className).toContain('collapsed');

        fireEvent.click(toggleBtn);
        expect(sidebar.className).not.toContain('collapsed');
    });

    test('InstructionWidget toggles state with sidebar widget', () => {
        customRender(<InstructionSidebarWidget />);
        const toggleBtn = screen.getByTestId('instruction-widget-toggle');

        expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

        fireEvent.click(toggleBtn);
        expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

        fireEvent.click(toggleBtn);
        expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    });

    test('LeftSidebar initializes correctly', () => {
        customRender(<LeftSidebar widgetIds={[]} />);
        const sidebar = screen.getByTestId('left-sidebar');
        expect(sidebar.className).toContain('collapsed');
    });

    test('InstructionWidget expands by clicking Edit button', () => {
        customRender(<InstructionWidget />);

        // Starts collapsed (default false)
        // Should show "Edit instruction" button
        const editBtn = screen.getByTestId('instruction-edit-button');
        expect(editBtn).toBeInTheDocument();

        // Click Edit
        fireEvent.click(editBtn);

        // Now should be expanded
        // Should show "Looks good" button
        const looksGoodBtn = screen.getByTestId('instruction-looks-good-button');
        expect(looksGoodBtn).toBeInTheDocument();

        // "Edit instruction" button should NOT be present (it's in the collapsed view)
        expect(screen.queryByTestId('instruction-edit-button')).not.toBeInTheDocument();
    });

    test('InstructionWidget collapses by clicking Looks good button', () => {
        customRender(<InstructionWidget />);

        // Precondition: Expand it first
        const editBtn = screen.getByTestId('instruction-edit-button');
        fireEvent.click(editBtn);

        // Verify expanded
        const looksGoodBtn = screen.getByTestId('instruction-looks-good-button');
        expect(looksGoodBtn).toBeInTheDocument();

        // Action: Click "Looks good"
        fireEvent.click(looksGoodBtn);

        // Verify Collapsed
        expect(screen.queryByTestId('instruction-looks-good-button')).not.toBeInTheDocument();
        expect(screen.getByTestId('instruction-edit-button')).toBeInTheDocument();
    });
});

describe('LayoutContext Responsive Initialization', () => {
    const originalInnerWidth = window.innerWidth;

    afterEach(() => {
        // Restore window.innerWidth
        Object.defineProperty(window, 'innerWidth', {
            writable: true,
            configurable: true,
            value: originalInnerWidth,
        });
    });

    test('Initializes with Right Sidebar EXPANDED on Desktop (>768px)', () => {
        // Set width to desktop
        Object.defineProperty(window, 'innerWidth', {
            writable: true,
            configurable: true,
            value: 1024,
        });

        customRender(<LayoutStateTester />);
        expect(screen.getByTestId('layout-state')).toHaveTextContent('expanded');
    });

    test('Initializes with Right Sidebar COLLAPSED on Mobile (<=768px)', () => {
        // Set width to mobile
        Object.defineProperty(window, 'innerWidth', {
            writable: true,
            configurable: true,
            value: 500,
        });

        customRender(<LayoutStateTester />);
        expect(screen.getByTestId('layout-state')).toHaveTextContent('collapsed');
    });
});
