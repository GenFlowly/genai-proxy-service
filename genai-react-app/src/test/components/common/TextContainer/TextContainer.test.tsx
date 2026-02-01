import React from 'react';
import { render, screen } from '@testing-library/react';
import TextContainer from '../../../../components/common/TextContainer/TextContainer';
import '@testing-library/jest-dom';

// Mock ReactMarkdown and plugins to avoid ESM issues and simplify testing
jest.mock('react-markdown', () => (props: any) => {
    return <div data-testid="markdown-content">{props.children}</div>;
});
jest.mock('remark-gfm', () => () => { });
jest.mock('rehype-highlight', () => () => { });

describe('TextContainer Component', () => {
    const defaultProps = {
        content: 'Markdown Content',
        'data-testid': 'test-container'
    };

    test('renders content correctly', () => {
        render(<TextContainer {...defaultProps} />);

        const container = screen.getByTestId('test-container');
        expect(container).toBeInTheDocument();

        const markdown = screen.getByTestId('markdown-content');
        expect(markdown).toHaveTextContent('Markdown Content');
    });

    test('renders loading state', () => {
        render(<TextContainer {...defaultProps} isLoading={true} loadingContent={<div data-testid="custom-loading">Loading...</div>} />);

        const loading = screen.getByTestId('custom-loading');
        expect(loading).toBeInTheDocument();
        expect(loading).toHaveTextContent('Loading...');

        // Should not render markdown when loading
        expect(screen.queryByTestId('markdown-content')).not.toBeInTheDocument();
    });

    test('renders nothing when loading if no loadingContent provided', () => {
        render(<TextContainer {...defaultProps} isLoading={true} />);
        expect(screen.queryByTestId('markdown-content')).not.toBeInTheDocument();
        // and no loading content
        expect(screen.queryByTestId('test-container-loading')).not.toBeInTheDocument();
    });

    test('does NOT render loadingContent when isLoading is false', () => {
        render(<TextContainer {...defaultProps} isLoading={false} loadingContent={<div data-testid="should-not-exist">Loading...</div>} />);

        expect(screen.queryByTestId('should-not-exist')).not.toBeInTheDocument();
        expect(screen.getByTestId('markdown-content')).toBeInTheDocument();
    });

    test('renders title as string', () => {
        render(<TextContainer {...defaultProps} title="My Title" />);

        const header = screen.getByTestId('test-container-header');
        expect(header).toBeInTheDocument();
        expect(header).toHaveTextContent('My Title');
        expect(header.querySelector('h2')).toBeInTheDocument();
    });

    test('renders title as component', () => {
        render(<TextContainer {...defaultProps} title={<span data-testid="custom-title">Custom Title</span>} />);

        const customTitle = screen.getByTestId('custom-title');
        expect(customTitle).toBeInTheDocument();
        expect(customTitle).toHaveTextContent('Custom Title');
    });

    test('shows copy button by default', () => {
        render(<TextContainer {...defaultProps} />);

        const copyButton = screen.getByTestId('test-container-copy-button');
        expect(copyButton).toBeInTheDocument();
    });

    test('hides copy button when prop is false', () => {
        render(<TextContainer {...defaultProps} showCopyButton={false} />);

        expect(screen.queryByTestId('test-container-copy-button')).not.toBeInTheDocument();
        expect(screen.queryByTestId('test-container-header')).not.toBeInTheDocument();
    });

    test('renders children', () => {
        render(
            <TextContainer {...defaultProps}>
                <div data-testid="child-element">Child</div>
            </TextContainer>
        );

        expect(screen.getByTestId('child-element')).toBeInTheDocument();
    });
});

import { extractText, PreBlock } from '../../../../components/common/TextContainer/TextContainer';

describe('TextContainer Internals', () => {
    describe('extractText', () => {
        test('extracts text from simple node', () => {
            const nodes = [{ value: 'Hello' }];
            expect(extractText(nodes)).toBe('Hello');
        });

        test('extracts text from nested nodes', () => {
            const nodes = [
                { value: 'Hello ' },
                { children: [{ value: 'World' }] }
            ];
            expect(extractText(nodes)).toBe('Hello World');
        });

        test('handles empty input', () => {
            expect(extractText([])).toBe('');
        });

        test('ignores nodes without value or children', () => {
            const nodes = [{ other: 'prop' }, { value: 'Text' }];
            expect(extractText(nodes)).toBe('Text');
        });
    });

    describe('PreBlock', () => {
        test('renders pre block with copy button', () => {
            const node = {
                children: [{ value: 'console.log("test")' }]
            };

            render(
                <PreBlock node={node}>
                    <code>console.log("test")</code>
                </PreBlock>
            );

            expect(screen.getByTitle('Copy Code')).toBeInTheDocument();
            expect(screen.getByText('console.log("test")')).toBeInTheDocument();
        });

        test('handles node without children', () => {
            render(
                <PreBlock>
                    <code>Info</code>
                </PreBlock>
            );
            expect(screen.getByTitle('Copy Code')).toBeInTheDocument();
        });
    });
});
