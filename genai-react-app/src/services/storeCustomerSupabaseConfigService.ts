import { StoreCustomerSupabaseConfigRequest, StoreCustomerSupabaseConfigResponse } from '../models/storeCustomerSupabaseConfig.models'
import { endpoints } from '../config/endpoints'

export const storeCustomerSupabaseConfig = async (
    token: string,
    request: StoreCustomerSupabaseConfigRequest
): Promise<StoreCustomerSupabaseConfigResponse> => {
    try {
        const response = await fetch(endpoints.storeCustomerSupabaseConfig, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(request)
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Failed to store Supabase configuration: ${response.status} ${response.statusText} - ${errorText}`)
        }

        const data: StoreCustomerSupabaseConfigResponse = await response.json()
        return data
    } catch (error) {
        console.error('storeCustomerSupabaseConfig error:', error)
        throw error
    }
}
