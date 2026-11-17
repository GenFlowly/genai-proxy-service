import React from 'react';
import { render, act, waitFor, screen } from '@testing-library/react';
import { AuthProvider, useAuth } from '../../context/AuthContext';
import { InstructionResponse } from '../../models/instruction.models';

// Minimal stable mock for useAuth0
const STABLE_USER = { sub: 'sub123', email: 'test@example.com' };
const mockGetAccessTokenSilently = jest.fn().mockResolvedValue('token');
const mockLogout = jest.fn();

jest.mock('@auth0/auth0-react', () => ({
    Auth0Provider: ({ children }: any) => children,
    useAuth0: () => ({
        isAuthenticated: true,
        user: STABLE_USER,
        getAccessTokenSilently: mockGetAccessTokenSilently,
        isLoading: false,
        logout: mockLogout,
    }),
}));

import { MemoryRouter } from 'react-router';
import { LayoutProvider } from '../../context/LayoutContext';

import { onboardCustomer } from '../../services/onboardUserService';
jest.mock('../../services/onboardUserService', () => ({
    onboardCustomer: jest.fn(),
}));

jest.mock('../../services/instructionService', () => ({
    getCustomerInstructions: jest.fn().mockResolvedValue({ instructions: [] }),
}));


const TestComponent = () => {
    const auth = useAuth();
    return (
        <div>
            <div data-testid="cust-id">{auth.customerId || 'NONE'}</div>
            <div data-testid="inst-count">{auth.customerInstructions.length}</div>
            <div data-testid="vdb-count">{auth.vectorDBConfigStatusList.length}</div>
            <div data-testid="vendor-count">{auth.aiVendorAPIKeyStatusList.length}</div>

            <button onClick={() => auth.updateInstruction({ id: 'i1', version: 1, name: 'v1' } as any)} data-testid="upd-inst-1">Add Inst 1</button>
            <button onClick={() => auth.updateInstruction({ id: 'i1', version: 1, name: 'v1-updated' } as any)} data-testid="upd-inst-1-upd">Update Inst 1</button>
            <button onClick={() => auth.updateInstruction({ id: 'i1', version: 2, name: 'v2' } as any)} data-testid="upd-inst-1-v2">Add Inst 1 v2</button>

            <button onClick={() => auth.updateVendorApiKeyStatus({ aiVendor: 'OPENAI', isAPIKeyValid: true } as any)} data-testid="upd-vendor-new">Add Vendor</button>
            <button onClick={() => auth.updateVendorApiKeyStatus({ aiVendor: 'OPENAI', isAPIKeyValid: false } as any)} data-testid="upd-vendor-upd">Update Vendor</button>

            <button onClick={() => auth.updateVectorDBConfigStatus({ vendor: 'PINECONE', isConfigValid: true } as any)} data-testid="upd-vdb-new">Add VDB</button>
            <button onClick={() => auth.updateVectorDBConfigStatus({ vendor: 'PINECONE', isConfigValid: false } as any)} data-testid="upd-vdb-upd">Update VDB</button>
            <button onClick={() => auth.resyncAccount()} data-testid="resync">Resync</button>
        </div>
    );
};

describe('AuthContext Functions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (onboardCustomer as jest.Mock).mockResolvedValue({
            customerId: 'c1',
            customerInstructions: [],
            aiVendorAPIKeyStatusList: [],
            vectorDBConfigStatusList: []
        });
    });

    test('updateInstruction adds or updates correctly', async () => {
        render(
            <MemoryRouter>
                <LayoutProvider>
                    <AuthProvider>
                        <TestComponent />
                    </AuthProvider>
                </LayoutProvider>
            </MemoryRouter>
        );

        // Wait for onboarding to settle
        await waitFor(() => expect(screen.getByTestId('cust-id')).toHaveTextContent('c1'), { timeout: 5000 });
        expect(screen.getByTestId('inst-count')).toHaveTextContent('0');

        // Add Inst 1
        await act(async () => {
            screen.getByTestId('upd-inst-1').click();
        });
        expect(screen.getByTestId('inst-count')).toHaveTextContent('1');

        // Update same version
        await act(async () => {
            screen.getByTestId('upd-inst-1-upd').click();
        });
        expect(screen.getByTestId('inst-count')).toHaveTextContent('1');

        // Add different version (prepend)
        await act(async () => {
            screen.getByTestId('upd-inst-1-v2').click();
        });
        expect(screen.getByTestId('inst-count')).toHaveTextContent('2');
    }, 15000);

    test('vendor and vdb status updaters', async () => {
        render(
            <MemoryRouter>
                <LayoutProvider>
                    <AuthProvider>
                        <TestComponent />
                    </AuthProvider>
                </LayoutProvider>
            </MemoryRouter>
        );

        await waitFor(() => expect(screen.getByTestId('cust-id')).toHaveTextContent('c1'), { timeout: 5000 });
        expect(screen.getByTestId('vendor-count')).toHaveTextContent('0');

        // Vendor
        await act(async () => {
            screen.getByTestId('upd-vendor-new').click();
        });
        expect(screen.getByTestId('vendor-count')).toHaveTextContent('1');

        await act(async () => {
            screen.getByTestId('upd-vendor-upd').click();
        });
        expect(screen.getByTestId('vendor-count')).toHaveTextContent('1');

        // VDB
        await act(async () => {
            screen.getByTestId('upd-vdb-new').click();
        });
        expect(screen.getByTestId('vdb-count')).toHaveTextContent('1');

        await act(async () => {
            screen.getByTestId('upd-vdb-upd').click();
        });
        expect(screen.getByTestId('vdb-count')).toHaveTextContent('1');
    }, 15000);

    test('resyncAccount re-runs the onboard sync and applies its key statuses', async () => {
        render(
            <MemoryRouter>
                <LayoutProvider>
                    <AuthProvider>
                        <TestComponent />
                    </AuthProvider>
                </LayoutProvider>
            </MemoryRouter>
        );
        await waitFor(() => expect(screen.getByTestId('cust-id')).toHaveTextContent('c1'), { timeout: 5000 });
        const callsBefore = (onboardCustomer as jest.Mock).mock.calls.length;
        (onboardCustomer as jest.Mock).mockResolvedValue({
            customerId: 'c1',
            customerInstructions: [],
            aiVendorAPIKeyStatusList: [{ aiVendor: 'OPENAI', status: 'NOT_SET', isAPIKeyValid: false }],
            vectorDBConfigStatusList: []
        });

        act(() => {
            screen.getByTestId('resync').click();
        });

        await waitFor(() => expect((onboardCustomer as jest.Mock).mock.calls.length).toBe(callsBefore + 1));
        await waitFor(() => expect(screen.getByTestId('vendor-count')).toHaveTextContent('1'));
    }, 15000);

});
// Trigger coverage run
