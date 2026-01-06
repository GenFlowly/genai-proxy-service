import React from 'react';
import { render, screen } from '@testing-library/react';
import { VendorAPIKeyStatus } from '../../../../components/common/VendorAPIKeyStatus/VendorAPIKeyStatus';
import { useAuth } from '../../../../context/AuthContext';
import { AIVendor } from '../../../../constants/vendors';
import { APIKeyStatus } from '../../../../models/storeCustomerVendorAPIKeys.models';
import '@testing-library/jest-dom';

// Mock useAuth
jest.mock('../../../../context/AuthContext', () => ({
    useAuth: jest.fn()
}));

describe('VendorAPIKeyStatus Component', () => {
    const mockUseAuth = useAuth as jest.Mock;
    const defaultProps = {
        vendor: 'openai' as AIVendor,
        'data-testid': 'test-status'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders NOT_SET when no status found for vendor', () => {
        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: []
        });

        render(<VendorAPIKeyStatus {...defaultProps} />);

        const container = screen.getByTestId('test-status');
        expect(container).toBeInTheDocument();

        const text = screen.getByTestId('test-status-text');
        expect(text).toHaveTextContent(APIKeyStatus.NOT_SET);
        expect(screen.queryByTestId('test-status-valid')).not.toBeInTheDocument();
    });

    test('renders VALID status with icon', () => {
        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: [{
                aiVendor: 'openai',
                status: APIKeyStatus.VALID,
                isAPIKeyValid: true
            }]
        });

        render(<VendorAPIKeyStatus {...defaultProps} />);

        const validContainer = screen.getByTestId('test-status-valid');
        expect(validContainer).toBeInTheDocument();

        const icon = screen.getByTestId('test-status-icon');
        expect(icon).toBeInTheDocument();

        expect(screen.getByTestId('test-status-text')).toHaveTextContent(APIKeyStatus.VALID);
    });

    test('renders INVALID status', () => {
        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: [{
                aiVendor: 'openai',
                status: APIKeyStatus.INVALID,
                isAPIKeyValid: false
            }]
        });

        render(<VendorAPIKeyStatus {...defaultProps} />);

        const otherContainer = screen.getByTestId('test-status-other');
        expect(otherContainer).toBeInTheDocument();

        expect(screen.getByTestId('test-status-text')).toHaveTextContent(APIKeyStatus.INVALID);
        expect(screen.queryByTestId('test-status-valid')).not.toBeInTheDocument();
    });
});


