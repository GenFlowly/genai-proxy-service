import { AIVendorAPIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'
import { OnboardCustomerResponse } from '../models/onboardUser.models'
import { VectorDBConfigStatusValue } from '../models/storeCustomerVectorDBConfig.models'
import { InstructionResponse } from '../models/instruction.models'

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
    setCustomerId: (id: string | null) => void;
    aiVendorAPIKeyStatusList: AIVendorAPIKeyStatus[];
    vectorDBConfigStatusList: {
        vendor: string;
        isConfigValid: boolean;
        status: VectorDBConfigStatusValue;
        updateSuccessful: boolean;
    }[];
    updateVendorApiKeyStatus: (status: AIVendorAPIKeyStatus) => void;
    aiConfigPreferences: OnboardCustomerResponse['aiConfigPreferences'] | null;
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