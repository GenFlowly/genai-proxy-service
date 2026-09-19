import { AIVendorAPIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'
import { OnboardCustomerResponse } from '../models/onboardUser.models'
import { StoreCustomerVectorDBConfigResponse, VectorDBConfigStatusValue } from '../models/storeCustomerVectorDBConfig.models'
import { InstructionResponse } from '../models/instruction.models'

export interface User {
    sub: string;
    email?: string;
    name?: string;
    picture?: string;
}

// Central place for feature entitlements. Derived from auth state so
// components never gate features on ad-hoc checks.
export interface Entitlements {
    canShare: boolean;
}

export interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    entitlements: Entitlements;
    isLoading: boolean;
    // True while the background /onboard sync is in flight for an
    // authenticated user; strict isAuthenticated stays false until it succeeds
    isOnboarding: boolean;
    isInstructionsLoaded: boolean;
    loginWithRedirect: (options?: any) => Promise<void>;
    logout: (options: { returnTo: string; localOnly?: boolean }) => void;
    getAccessTokenSilently: () => Promise<string>;
    customerId: string | null;
    setCustomerId: (id: string | null) => void;
    aiVendorAPIKeyStatusList: AIVendorAPIKeyStatus[];
    vectorDBConfigStatusList: {
        vendor: string;
        isConfigValid: boolean;
        status: VectorDBConfigStatusValue;
        updateSuccessful: boolean;
    }[];
    updateVendorApiKeyStatus: (status: AIVendorAPIKeyStatus) => void;
    updateVectorDBConfigStatus: (status: StoreCustomerVectorDBConfigResponse['configStatus']) => void;
    aiConfigPreferences: OnboardCustomerResponse['aiConfigPreferences'] | null;
    updateAiConfigPreferences: (
        partial: Partial<NonNullable<OnboardCustomerResponse['aiConfigPreferences']>>
    ) => void;
    customerInstructions: InstructionResponse[];
    refreshInstructions: () => Promise<void>;
    updateInstruction: (instruction: InstructionResponse) => void;
    customerName?: string;
    customerPicture?: string;
}

export interface AuthProviderProps {
    children: React.ReactNode;
    domain: string;
    clientId: string;
    audience: string;
}