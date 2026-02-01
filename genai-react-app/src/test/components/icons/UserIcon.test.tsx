import React from 'react';
import { render } from '@testing-library/react';
import UserIcon from '../../../components/icons/UserIcon';
import '@testing-library/jest-dom';

describe('UserIcon', () => {
    test('renders correctly', () => {
        const { container } = render(<UserIcon />);
        expect(container.querySelector('svg')).toBeInTheDocument();
    });
});
