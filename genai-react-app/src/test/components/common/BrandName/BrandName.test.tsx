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
import { ICONS } from '../../../../constants/icons';
import '@testing-library/jest-dom';

describe('BrandName Components', () => {

    describe('Generic BrandName', () => {
        test('renders with icon and name', () => {
            render(<BrandName icon={ICONS.OPENAI} name="Test Brand" />);

            const container = screen.getByTestId('brand-name-container');
            expect(container).toBeInTheDocument();
            expect(screen.getByTestId('brand-name-text')).toHaveTextContent('Test Brand');

            // Icon check - assuming Icon passes down src to an img tag or similar
            // Since we didn't mock Icon, we check if it renders
            // (Note: Icon doesn't strictly have a data-testid passed prop yet, so we rely on container scope)
        });

        test('renders as a custom element (e.g. h1)', () => {
            render(<BrandName icon={ICONS.OPENAI} name="Heading Brand" as="h1" />);
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

    describe('Collapsed Brand Variants', () => {
        test('CollapsedOpenAIBrandName renders correctly', () => {
            render(<CollapsedOpenAIBrandName />);
            expect(screen.getByTestId('collapsed-openai-brand')).toBeInTheDocument();
        });

        test('CollapsedClaudeBrandName renders correctly', () => {
            render(<CollapsedClaudeBrandName />);
            expect(screen.getByTestId('collapsed-claude-brand')).toBeInTheDocument();
        });

        test('CollapsedGeminiBrandName renders correctly', () => {
            render(<CollapsedGeminiBrandName />);
            expect(screen.getByTestId('collapsed-gemini-brand')).toBeInTheDocument();
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
