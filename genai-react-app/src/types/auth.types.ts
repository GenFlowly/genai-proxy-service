import { AIVendorAPIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'
import { OnboardCustomerResponse } from '../models/onboardUser.models'
import { InstructionResponseItem } from '../models/instruction.models'

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
    aiConfigPreferences: OnboardCustomerResponse['aiConfigPreferences'] | null;
    customerInstructions: InstructionResponseItem[];
    refreshInstructions: () => Promise<void>;
    updateInstruction: (instruction: InstructionResponseItem) => void;
}

export interface AuthProviderProps {
    children: React.ReactNode;
    domain: string;
    clientId: string;
    audience: string;
}