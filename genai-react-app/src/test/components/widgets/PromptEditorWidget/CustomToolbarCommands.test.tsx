import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { addStepsCommand, addExamplesCommand, addCopyCommand } from '../../../../components/widgets/PromptEditorWidget/CustomToolbarCommands';
import '@testing-library/jest-dom';

// Mocks
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    Icon: ({ alt }: any) => <span data-testid={`icon-${alt}`}>{alt}</span>,
    Tooltip: ({ content, children }: any) => <div data-testid="tooltip-mock" data-content={content}>{children}</div>,
}));

const createMockEditor = (docString: string, selection = { from: 0, to: 0 }) => {
    const dispatch = jest.fn();
    return {
        view: {
            state: {
                doc: {
                    toString: () => docString
                },
                selection: {
                    main: selection
                }
            },
            dispatch
        },
        // Mock dispatch getter for checking calls
        getDispatch: () => dispatch
    };
};

describe('CustomToolbarCommands', () => {
    describe('addStepsCommand', () => {
        test('renders icon correctly', () => {
            render(addStepsCommand.icon);
            expect(screen.getByText('Add Step')).toBeInTheDocument();
            expect(screen.getByTestId('icon-Steps')).toBeInTheDocument();
        });

        test('inserts initial Step 1 if no steps exist', () => {
            const editor = createMockEditor('Some text');
            addStepsCommand.execute(editor);

            const dispatch = editor.getDispatch();
            expect(dispatch).toHaveBeenCalledWith({
                changes: {
                    from: 0,
                    to: 0,
                    insert: '\n\nFollow these steps -\nStep 1:\n'
                }
            });
        });

        test('increments step number if steps exist', () => {
            const editor = createMockEditor('Intro\n\nFollow these steps -\nStep 1:\nDo this\nStep 2:\nThen this', { from: 50, to: 50 });
            addStepsCommand.execute(editor);

            const dispatch = editor.getDispatch();
            expect(dispatch).toHaveBeenCalledWith({
                changes: {
                    from: 50,
                    to: 50,
                    insert: '\nStep 3:\n'
                }
            });
        });

        test('handles complex step numbering', () => {
            // Case with disparate numbers
            const editor = createMockEditor('Step 1:\nStep 10:\n', { from: 20, to: 20 });
            addStepsCommand.execute(editor);

            const dispatch = editor.getDispatch();
            expect(dispatch).toHaveBeenCalledWith({
                changes: {
                    from: 20,
                    to: 20,
                    insert: '\nStep 11:\n'
                }
            });
        });
    });

    describe('addExamplesCommand', () => {
        test('renders icon correctly', () => {
            render(addExamplesCommand.icon);
            expect(screen.getByText('Add Example')).toBeInTheDocument();
            expect(screen.getByTestId('icon-Examples')).toBeInTheDocument();
        });

        test('inserts initial Example 1 if no examples exist', () => {
            const editor = createMockEditor('Some text');
            addExamplesCommand.execute(editor);

            const dispatch = editor.getDispatch();
            expect(dispatch).toHaveBeenCalledWith({
                changes: {
                    from: 0,
                    to: 0,
                    insert: '\n\nExamples\n\nExample 1 - \nUser - \nResponse - \n'
                }
            });
        });

        test('increments example number if examples exist', () => {
            const editor = createMockEditor('Example 1 - \n...\nExample 2 - \n...', { from: 50, to: 50 });
            addExamplesCommand.execute(editor);

            const dispatch = editor.getDispatch();
            expect(dispatch).toHaveBeenCalledWith({
                changes: {
                    from: 50,
                    to: 50,
                    insert: '\n\nExample 3 - \nUser - \nResponse - \n'
                }
            });
        });
    });

    describe('addCopyCommand', () => {
        const mockWriteText = jest.fn();

        beforeAll(() => {
            Object.assign(navigator, {
                clipboard: {
                    writeText: mockWriteText.mockImplementation(() => Promise.resolve()),
                },
            });
        });

        beforeEach(() => {
            jest.clearAllMocks();
            mockWriteText.mockResolvedValue(undefined); // Ensure it returns a Promise
            jest.useFakeTimers(); // Enable fake timers
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('has correct properties', () => {
            expect(addCopyCommand.name).toBe('copy');
            expect(addCopyCommand.keyCommand).toBe('copy');
        });

        test('renders copy button and handles click', async () => {
            const docContent = 'Content to copy';
            const editor = createMockEditor(docContent);

            const options = {
                editor: {
                    current: {
                        view: editor.view
                    }
                }
            };

            const ButtonComponent = addCopyCommand.button;
            render(ButtonComponent(null, null, options));

            // Verify initial state
            expect(screen.getByTestId('tooltip-mock')).toHaveAttribute('data-content', 'Copy to clipboard');
            expect(screen.queryByText('✓')).not.toBeInTheDocument();

            // Initial icon (undefined because alt is not passed, but we know it's not the checkmark)
            expect(screen.getByTestId('icon-Copy')).toBeInTheDocument();

            // Click the button
            // The tooltip renders a div, inside is the span with onClick
            const tooltip = screen.getByTestId('tooltip-mock');
            const buttonSpan = tooltip.firstChild as HTMLElement;
            fireEvent.click(buttonSpan);

            // Verify clipboard write
            expect(mockWriteText).toHaveBeenCalledWith(docContent);

            // Verify copied state (resolved promise)
            // waitFor acts as a way to wait for the Promise chain to resolve and state to update
            await waitFor(() => {
                expect(screen.getByText('✓')).toBeInTheDocument();
            });

            expect(screen.getByTestId('tooltip-mock')).toHaveAttribute('data-content', 'Copied!');
            expect(screen.queryByTestId('icon-Copy')).not.toBeInTheDocument();

            // Verify timeout (2000ms)
            act(() => {
                jest.advanceTimersByTime(2000);
            });

            // Verify reset to initial state
            await waitFor(() => {
                expect(screen.queryByText('✓')).not.toBeInTheDocument();
                expect(screen.getByTestId('icon-Copy')).toBeInTheDocument();
                expect(screen.getByTestId('tooltip-mock')).toHaveAttribute('data-content', 'Copy to clipboard');
            });
        });

        test('execute does nothing (handled by button)', () => {
            // Function exists but is a no-op
            expect(() => addCopyCommand.execute(null)).not.toThrow();
        });
    });
});
// Trigger coverage check
