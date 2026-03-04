export enum VectorDBConfigStatusValue {
    PRESENT = 'PRESENT',
    NOT_SET = 'NOT_SET'
}

export interface StoreCustomerVectorDBConfigRequest {
    vendor: string;
    endpoint: string;
    token: string;
}

export interface StoreCustomerVectorDBConfigResponse {
    configStatus: {
        vendor: string;
        isConfigValid: boolean;
        status: VectorDBConfigStatusValue;
        updateSuccessful: boolean;
    };
}
