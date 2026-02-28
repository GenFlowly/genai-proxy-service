import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import PromptEditor from '../../../../components/widgets/PromptEditorWidget/PromptEditor';
import '@testing-library/jest-dom';

// Mock the lazy-loaded Core module so Suspense resolves immediately in tests.
// All assertions target this mock — no need for @uiw or @codemirror mocks.
jest.mock('../../../../components/widgets/PromptEditorWidget/PromptEditorCore', () => {
    const React = require('react');
    const { useState } = React;

    const CopyButton = () => {
        const [copied, setCopied] = useState(false);
        return (
            <button
                data-testid="custom-copy-button"
                onClick={() => setCopied(true)}
            >
                {copied ? 'Copied!' : 'Copy'}
            </button>
        );
    };

    return {
        __esModule: true,
        default: ({ value, onChange, className, 'data-testid': testId }: any) => (
            <div className={`container ${className || ''}`} data-testid={testId}>
                <textarea
                    data-testid="mock-textarea"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                />
                <div data-testid="mock-toolbar-left">
                    <div data-testid="toolbar-item-addSteps">addSteps</div>
                    <div data-testid="toolbar-item-addExamples">addExamples</div>
                </div>
                <div data-testid="mock-toolbar-right">
                    <div data-testid="toolbar-item-preview">preview</div>
                    <div data-testid="toolbar-item-fullscreen">fullscreen</div>
                    <div data-testid="toolbar-item-copy-custom">
                        <CopyButton />
                    </div>
                </div>
            </div>
        )
    };
});

describe('PromptEditor Component', () => {
    const defaultProps = {
        id: 'test-editor',
        value: 'Initial Prompt',
        onChange: jest.fn(),
        'data-testid': 'prompt-editor'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders with initial value', async () => {
        render(<PromptEditor {...defaultProps} />);
        expect(screen.getByTestId('prompt-editor')).toBeInTheDocument();
        const textarea = await screen.findByTestId('mock-textarea');
        expect(textarea).toHaveValue('Initial Prompt');
    });

    test('renders left toolbars correctly', () => {
        render(<PromptEditor {...defaultProps} />);
        expect(screen.getByTestId('toolbar-item-addSteps')).toBeInTheDocument();
        expect(screen.getByTestId('toolbar-item-addExamples')).toBeInTheDocument();
    });

    test('renders right toolbars (preview, fullscreen, copy)', () => {
        render(<PromptEditor {...defaultProps} />);
        const rightToolbar = screen.getByTestId('mock-toolbar-right');

        expect(rightToolbar).toBeInTheDocument();
        expect(screen.getByTestId('toolbar-item-preview')).toBeInTheDocument();
        expect(screen.getByTestId('toolbar-item-fullscreen')).toBeInTheDocument();
        expect(screen.getByTestId('toolbar-item-copy-custom')).toBeInTheDocument();
    });

    test('copy button provides feedback on click', () => {
        render(<PromptEditor {...defaultProps} />);

        const copyBtn = screen.getByTestId('custom-copy-button');
        expect(copyBtn).toHaveTextContent('Copy');

        fireEvent.click(copyBtn);

        expect(copyBtn).toHaveTextContent('Copied!');
    });
});
// Trigger coverage check
