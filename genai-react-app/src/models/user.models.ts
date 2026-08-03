export interface SearchUserResponse {
    customerId: string;
    name?: string;
    username: string;
    picture?: string;
    role?: 'VIEW' | 'EDIT';
}

export interface CustomerProfileResponse {
    customerId: string;
    name?: string;
    email?: string;
    username?: string;
    picture?: string;
    isDiscoverable: boolean;
}
