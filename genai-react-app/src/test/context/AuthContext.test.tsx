import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../../context/AuthContext';
import { LayoutProvider } from '../../context/LayoutContext';
import { MOCK_USER, AUTH0_TOKEN_RESPONSE } from '../fixtures/auth0';
import { MemoryRouter } from 'react-router-dom';
import Navbar from '../../components/navbar/Navbar';
import { mockOnboardResponse } from '../fixtures/customerProfile'; // Import here to be available in scope
import { onboardCustomer } from '../../services/onboardUserService';
// We need to mock useAuth0 to control returned values per test
const mockUseAuth0 = jest.fn();

jest.mock('@auth0/auth0-react', () => ({
    Auth0Provider: ({ children }: any) => children,
    useAuth0: () => mockUseAuth0(),
}));

// Mock the onboarding service to prevent side effects/errors in console
jest.mock('../../services/onboardUserService', () => ({
    onboardCustomer: jest.fn()
}));

jest.mock('../../services/instructionService', () => ({
    getCustomerInstructions: jest.fn()
}));


jest.mock('../../services/instructionService', () => ({
    getCustomerInstructions: jest.fn()
}));


describe('AuthContext Integration with Navbar', () => {
    beforeEach(() => {
        mockUseAuth0.mockReset();
        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: false,
            user: null,
            getAccessTokenSilently: jest.fn(),
            logout: jest.fn(),
            loginWithRedirect: jest.fn(),
        });
        (onboardCustomer as jest.Mock).mockResolvedValue(mockOnboardResponse);
    });

    test('Shows Login button when unauthenticated', async () => {
        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: false,
            user: null,
            getAccessTokenSilently: jest.fn(),
        });

        render(
            <MemoryRouter>
                <LayoutProvider>
                    <AuthProvider>
                        <Navbar />
                    </AuthProvider>
                </LayoutProvider>
            </MemoryRouter>
        );

        expect(screen.getByTestId('login-button')).toBeInTheDocument();
        expect(screen.queryByTestId('user-avatar-button')).not.toBeInTheDocument();
    });

    test('Shows User Avatar when authenticated and accesses User Profile', async () => {
        const mockGetToken = jest.fn().mockResolvedValue(AUTH0_TOKEN_RESPONSE.access_token);

        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            user: MOCK_USER,
            getAccessTokenSilently: mockGetToken,
            logout: jest.fn(), // Required
        });

        render(
            <MemoryRouter>
                <LayoutProvider>
                    <AuthProvider>
                        <Navbar />
                    </AuthProvider>
                </LayoutProvider>
            </MemoryRouter>
        );

        // 1. Verify Avatar Present
        const avatarBtn = await screen.findByTestId('user-avatar-button');
        expect(avatarBtn).toBeInTheDocument();
        expect(screen.queryByTestId('login-button')).not.toBeInTheDocument();

        // 2. Open Dropdown
        act(() => {
            avatarBtn.click();
        });

        // 3. Verify User Name
        const userNameDisplay = await screen.findByTestId('user-name-display');
        expect(userNameDisplay).toHaveTextContent(`Hello ${MOCK_USER.name}`);

        // 4. Verify Token Fetch (AuthContext internal behavior)
        // This confirms AuthContext did its initialization
        await waitFor(() => {
            expect(mockGetToken).toHaveBeenCalled();
        });
    });


    test('Login button calls loginWithRedirect', async () => {
        const mockLogin = jest.fn();
        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: false,
            user: null, // User is null
            loginWithRedirect: mockLogin,
            getAccessTokenSilently: jest.fn(),
        });

        render(
            <MemoryRouter>
                <LayoutProvider>
                    <AuthProvider>
                        <Navbar />
                    </AuthProvider>
                </LayoutProvider>
            </MemoryRouter>
        );

        const loginBtn = screen.getByTestId('login-button');
        act(() => {
            loginBtn.click();
        });

        expect(mockLogin).toHaveBeenCalled();
    });

    test('Logs out if Auth0 succeeds and onboard API fails', async () => {
        // 1. Setup mocks for failure
        const mockError = new Error('API Error');
        (onboardCustomer as jest.Mock).mockRejectedValue(mockError);

        const mockGetToken = jest.fn().mockResolvedValue('token');
        const mockLogout = jest.fn();
        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            user: MOCK_USER,
            getAccessTokenSilently: mockGetToken,
            logout: mockLogout,
        });

        // 2. Render
        render(
            <MemoryRouter>
                <LayoutProvider>
                    <AuthProvider>
                        <Navbar />
                    </AuthProvider>
                </LayoutProvider>
            </MemoryRouter>
        );

        // 3. Verify Logout is called to clear Auth0 session/localStorage
        // We wait for this side effect since the onboard call is async
        await waitFor(() => {
            expect(mockLogout).toHaveBeenCalledWith({ logoutParams: { returnTo: window.location.origin } });
        });

    });

    test('Strictly uses Backend Profile data over Auth0 data', async () => {
        // 1. Setup: Auth0 says "Alice", Backend says "Bob"
        const auth0User = { ...MOCK_USER, name: 'Alice', picture: 'alice.jpg' };
        const backendResponse = {
            ...mockOnboardResponse,
            customerName: 'Bob',
            customerPicture: 'bob.jpg'
        };

        const mockGetToken = jest.fn().mockResolvedValue('token');
        (onboardCustomer as jest.Mock).mockResolvedValue(backendResponse);

        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            user: auth0User,
            getAccessTokenSilently: mockGetToken,
        });

        // 2. Render
        render(
            <MemoryRouter>
                <LayoutProvider>
                    <AuthProvider>
                        <Navbar />
                    </AuthProvider>
                </LayoutProvider>
            </MemoryRouter>
        );

        // 3. Open Profile Dropdown
        const avatarBtn = await screen.findByTestId('user-avatar-button');
        act(() => {
            avatarBtn.click();
        });

        // 4. Verify Display Name is from Backend ("Bob"), NOT Auth0 ("Alice")
        const userNameDisplay = await screen.findByTestId('user-name-display');
        expect(userNameDisplay).toHaveTextContent('Hello Bob');
        expect(userNameDisplay).not.toHaveTextContent('Alice');

        // Verify Avatar image source (UserAvatarButton uses displayPicture)
        // Note: checking src might be tricky if Avatar component handles it internally,
        // but we can check checking the prop passed if we mocked it, or check the img tag if strictly rendered.
        // UserAvatarButton renders an img if displayPicture is present.
        // UserAvatarButton renders an img if displayPicture is present.
        const img = screen.getByTestId('user-avatar-button-image');
        expect(img).toHaveAttribute('src', 'bob.jpg');
        expect(img).toHaveAttribute('alt', 'Bob');
    });
});

test('Handles corrupted localStorage for AI preferences gracefully', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
    // Mock default Auth0 state to avoid crash
    mockUseAuth0.mockReturnValue({
        isLoading: false,
        isAuthenticated: false,
        user: null,
        getAccessTokenSilently: jest.fn(),
        logout: jest.fn(),
    });

    Storage.prototype.getItem = jest.fn((key) => {
        if (key === 'customerId') return '123';
        if (key === '123_ai_preferences') return '{invalid_json}';
        return null;
    });

    render(
        <MemoryRouter>
            <LayoutProvider>
                <AuthProvider>
                    <Navbar />
                </AuthProvider>
            </LayoutProvider>
        </MemoryRouter>
    );

    expect(consoleSpy).toHaveBeenCalledWith('Failed to parse cached ai preferences', expect.any(Error));
    consoleSpy.mockRestore();
});

test('refreshInstructions calls service and updates state', async () => {
    const { getCustomerInstructions } = require('../../services/instructionService');
    const mockInstructions = [{ id: '1', version: 1, content: 'test' }];
    getCustomerInstructions.mockResolvedValue({ instructions: mockInstructions });

    const mockGetToken = jest.fn().mockResolvedValue('token');
    mockUseAuth0.mockReturnValue({
        isLoading: false,
        isAuthenticated: true,
        user: MOCK_USER,
        getAccessTokenSilently: mockGetToken,
        logout: jest.fn(),
    });

    (onboardCustomer as jest.Mock).mockResolvedValue({
        customerId: '123',
        customerInstructions: [],
        aiVendorAPIKeyStatusList: [],
        aiConfigPreferences: null
    });

    // Test component to trigger refresh
    const TestRefresh = () => {
        const { refreshInstructions, customerInstructions } = useAuth();
        return (
            <div>
                <button onClick={refreshInstructions} data-testid="refresh-btn">Refresh</button>
                <div data-testid="instr-count">{customerInstructions.length}</div>
            </div>
        );
    };

    render(
        <MemoryRouter>
            <LayoutProvider>
                <AuthProvider>
                    <TestRefresh />
                </AuthProvider>
            </LayoutProvider>
        </MemoryRouter>
    );

    const btn = screen.getByTestId('refresh-btn');
    await act(async () => {
        btn.click();
    });

    await waitFor(() => {
        expect(getCustomerInstructions).toHaveBeenCalled();
        expect(screen.getByTestId('instr-count')).toHaveTextContent('1');
    });
});

test('updateInstruction updates existing and adds new', async () => {
    (onboardCustomer as jest.Mock).mockResolvedValue({
        customerId: '123',
        customerInstructions: [{ id: 'init', version: 1, name: 'Initial' }],
        aiVendorAPIKeyStatusList: [],
        aiConfigPreferences: null
    });
    mockUseAuth0.mockReturnValue({
        isLoading: false,
        isAuthenticated: true,
        user: MOCK_USER,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
        logout: jest.fn(),
    });

    const TestUpdate = () => {
        const { updateInstruction, customerInstructions } = useAuth();
        return (
            <div>
                <button onClick={() => updateInstruction({ id: 'init', version: 1, name: 'Updated Initial' } as any)} data-testid="update-btn">Update</button>
                <button onClick={() => updateInstruction({ id: 'new', version: 1, name: 'New' } as any)} data-testid="add-btn">Add</button>
                <div data-testid="instr-list">{JSON.stringify(customerInstructions)}</div>
            </div>
        );
    };

    render(
        <MemoryRouter>
            <LayoutProvider>
                <AuthProvider>
                    <TestUpdate />
                </AuthProvider>
            </LayoutProvider>
        </MemoryRouter>
    );

    // 1. Wait for Onboard
    await waitFor(() => {
        expect(screen.getByTestId('instr-list')).toHaveTextContent('Initial');
    });

    // 2. Update Existing (Hit index !== -1)
    await act(async () => {
        screen.getByTestId('update-btn').click();
    });
    expect(screen.getByTestId('instr-list')).toHaveTextContent('Updated Initial');

    // 3. Add New (Hit index === -1)
    await act(async () => {
        screen.getByTestId('add-btn').click();
    });
    expect(screen.getByTestId('instr-list')).toHaveTextContent('New');
});

test('updateVendorApiKeyStatus updates existing and adds new', async () => {
    (onboardCustomer as jest.Mock).mockResolvedValue({
        customerId: '123',
        customerInstructions: [],
        aiVendorAPIKeyStatusList: [{ aiVendor: 'InitialVendor', status: 'valid' } as any],
        aiConfigPreferences: null
    });
    mockUseAuth0.mockReturnValue({
        isLoading: false,
        isAuthenticated: true,
        user: MOCK_USER,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
        logout: jest.fn(),
    });

    const TestVendor = () => {
        const { updateVendorApiKeyStatus, aiVendorAPIKeyStatusList } = useAuth();
        return (
            <div>
                <button onClick={() => updateVendorApiKeyStatus({ aiVendor: 'InitialVendor', isAPIKeyValid: false, status: 'invalid' } as any)} data-testid="update-existing">Update Existing</button>
                <button onClick={() => updateVendorApiKeyStatus({ aiVendor: 'NewVendor', isAPIKeyValid: true, status: 'valid' } as any)} data-testid="add-new">Add New</button>
                <div data-testid="vendor-list">{JSON.stringify(aiVendorAPIKeyStatusList)}</div>
            </div>
        );
    };

    render(
        <MemoryRouter>
            <LayoutProvider>
                <AuthProvider>
                    <TestVendor />
                </AuthProvider>
            </LayoutProvider>
        </MemoryRouter>
    );

    // 1. Wait for Onboard
    await waitFor(() => {
        expect(screen.getByTestId('vendor-list')).toHaveTextContent('InitialVendor');
    });

    // 2. Update Existing (Hit index !== -1)
    await act(async () => {
        screen.getByTestId('update-existing').click();
    });
    expect(screen.getByTestId('vendor-list')).toHaveTextContent('invalid');

    // 3. Add New (Hit index === -1)
    await act(async () => {
        screen.getByTestId('add-new').click();
    });
    expect(screen.getByTestId('vendor-list')).toHaveTextContent('NewVendor');
});

test('updateVectorDBConfigStatus updates existing and adds new', async () => {
    (onboardCustomer as jest.Mock).mockResolvedValue({
        customerId: '123',
        customerInstructions: [],
        aiVendorAPIKeyStatusList: [],
        vectorDBConfigStatusList: [{ vendor: 'Zilliz', status: 'NOT_SET' } as any],
        aiConfigPreferences: null
    });
    mockUseAuth0.mockReturnValue({
        isLoading: false,
        isAuthenticated: true,
        user: MOCK_USER,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
        logout: jest.fn(),
    });

    const TestVectorDB = () => {
        const { updateVectorDBConfigStatus, vectorDBConfigStatusList } = useAuth();
        return (
            <div>
                <button onClick={() => updateVectorDBConfigStatus({ vendor: 'Zilliz', isConfigValid: true, status: 'PRESENT', updateSuccessful: true } as any)} data-testid="update-existing">Update Existing</button>
                <button onClick={() => updateVectorDBConfigStatus({ vendor: 'Milvus', isConfigValid: false, status: 'NOT_SET', updateSuccessful: false } as any)} data-testid="add-new">Add New</button>
                <div data-testid="db-list">{JSON.stringify(vectorDBConfigStatusList)}</div>
            </div>
        );
    };

    render(
        <MemoryRouter>
            <LayoutProvider>
                <AuthProvider>
                    <TestVectorDB />
                </AuthProvider>
            </LayoutProvider>
        </MemoryRouter>
    );

    // 1. Wait for Onboard
    await waitFor(() => {
        expect(screen.getByTestId('db-list')).toHaveTextContent('Zilliz');
    });

    // 2. Update Existing (Hit index !== -1)
    await act(async () => {
        screen.getByTestId('update-existing').click();
    });
    expect(screen.getByTestId('db-list')).toHaveTextContent('PRESENT');

    // 3. Add New (Hit index === -1)
    await act(async () => {
        screen.getByTestId('add-new').click();
    });
    expect(screen.getByTestId('db-list')).toHaveTextContent('Milvus');
});

test('Logs out for login_required error', async () => {
    const mockLogout = jest.fn();
    const loginReqError = { error: 'login_required' };
    (onboardCustomer as jest.Mock).mockRejectedValue(loginReqError);

    mockUseAuth0.mockReturnValue({
        isLoading: false,
        isAuthenticated: true,
        user: MOCK_USER,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
        logout: mockLogout,
    });

    render(
        <MemoryRouter>
            <LayoutProvider>
                <AuthProvider><Navbar /></AuthProvider>
            </LayoutProvider>
        </MemoryRouter>
    );

    await waitFor(() => {
        // Should log message "Session invalid..." and logout
        expect(mockLogout).toHaveBeenCalledWith({ logoutParams: { returnTo: window.location.origin } });
    });
});

// Coverage refresh
