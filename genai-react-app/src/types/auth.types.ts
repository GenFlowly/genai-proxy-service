export interface User {
    sub: string;
    email?: string;
    name?: string;
    picture?: string;
}

export interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    loginWithRedirect: () => void;
    logout: (options: { returnTo: string }) => void;
    getAccessTokenSilently: () => Promise<string>;
    customerId: string | null;
    setCustomerId: (id: string | null) => void
}

export interface AuthProviderProps {
    children: React.ReactNode;
    domain: string;
    clientId: string;
    audience: string;
}