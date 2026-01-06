import { render, screen } from '@testing-library/react';
import { addStepsCommand, addExamplesCommand } from '../../../../components/widgets/PromptEditorWidget/CustomToolbarCommands';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../components/common/Icon/Icon', () => ({
    Icon: ({ alt }: any) => <span data-testid={`icon-${alt}`}>{alt}</span>
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
});
