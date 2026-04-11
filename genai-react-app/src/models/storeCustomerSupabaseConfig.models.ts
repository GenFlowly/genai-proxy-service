export enum SupabaseConfigStatusValue {
    PRESENT = 'PRESENT',
    NOT_SET = 'NOT_SET'
}

export interface StoreCustomerSupabaseConfigRequest {
    endpoint: string;
    token: string;
    password?: string;
}

export interface SupabaseConfigStatus {
    isConfigValid: boolean;
    status: SupabaseConfigStatusValue;
    updateSuccessful: boolean;
}

export interface StoreCustomerSupabaseConfigResponse {
    configStatus: SupabaseConfigStatus;
}
