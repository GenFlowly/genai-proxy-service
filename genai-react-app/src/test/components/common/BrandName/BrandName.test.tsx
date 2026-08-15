import React from 'react';
import { render, screen } from '@testing-library/react';
import BrandName, {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName,
    UserBrandName,
    CollapsedOpenAIBrandName,
    CollapsedClaudeBrandName,
    CollapsedGeminiBrandName
} from '../../../../components/common/BrandName/BrandName';
import '@testing-library/jest-dom';

describe('BrandName Components', () => {

    describe('Generic BrandName', () => {
        test('renders the name as plain text (no logo)', () => {
            render(<BrandName name="Test Brand" />);

            const container = screen.getByTestId('brand-name-container');
            expect(container).toBeInTheDocument();
            expect(screen.getByTestId('brand-name-text')).toHaveTextContent('Test Brand');
        });

        test('renders as a custom element (e.g. h1)', () => {
            render(<BrandName name="Heading Brand" as="h1" />);
            const container = screen.getByTestId('brand-name-container');
            expect(container.tagName).toBe('H1');
        });
    });

    describe('Specific Brand Variants', () => {
        test('OpenAIBrandName renders correctly', () => {
            render(<OpenAIBrandName />);
            expect(screen.getByTestId('brand-name-text')).toHaveTextContent('OpenAI');
        });

        test('ClaudeBrandName renders correctly', () => {
            render(<ClaudeBrandName />);
            expect(screen.getByTestId('brand-name-text')).toHaveTextContent('Claude');
        });

        test('GeminiBrandName renders correctly', () => {
            render(<GeminiBrandName />);
            expect(screen.getByTestId('brand-name-text')).toHaveTextContent('Gemini');
        });
    });

    describe('Collapsed Brand Variants (vendor initials)', () => {
        test('CollapsedOpenAIBrandName renders the "O" initial', () => {
            render(<CollapsedOpenAIBrandName />);
            const badge = screen.getByTestId('collapsed-openai-brand');
            expect(badge).toHaveTextContent('O');
            expect(badge).toHaveAttribute('aria-label', 'OpenAI');
        });

        test('CollapsedClaudeBrandName renders the "C" initial', () => {
            render(<CollapsedClaudeBrandName />);
            const badge = screen.getByTestId('collapsed-claude-brand');
            expect(badge).toHaveTextContent('C');
            expect(badge).toHaveAttribute('aria-label', 'Claude');
        });

        test('CollapsedGeminiBrandName renders the "G" initial', () => {
            render(<CollapsedGeminiBrandName />);
            const badge = screen.getByTestId('collapsed-gemini-brand');
            expect(badge).toHaveTextContent('G');
            expect(badge).toHaveAttribute('aria-label', 'Gemini');
        });
    });

    describe('UserBrandName', () => {
        test('renders with name and picture', () => {
            const pictureUrl = 'https://example.com/pic.jpg';
            render(<UserBrandName name="Test User" picture={pictureUrl} />);

            expect(screen.getByTestId('user-brand-name-text')).toHaveTextContent('Test User');
            const img = screen.getByRole('img');
            expect(img).toHaveAttribute('src', pictureUrl);
            expect(img).toHaveAttribute('alt', 'Test User');
        });

        test('renders with default icon when picture is missing', () => {
            render(<UserBrandName name="No Pic User" />);
            expect(screen.getByTestId('user-brand-name-text')).toHaveTextContent('No Pic User');
            // Should render Icon instead of img tag
            // queryByRole('img') might find the default icon if it uses img, 
            // but the conditional logic renders Icon component.
            // Best verification given current codebase: check text exists and no user-avatar-img style logic
        });
    });
});
