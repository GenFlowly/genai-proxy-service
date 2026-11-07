import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import { InstructionUsageResponse } from '../../models/instruction.models'
import { SearchUserResponse } from '../../models/user.models'
import { getInstructionSharedUsers, getInstructionUsage } from '../../services/instructionService'
import { INSTRUCTION_SHARES_QUERY_KEY, INSTRUCTION_USAGE_QUERY_KEY } from './queryKeys'

/** The caller's own use of the instruction. */
export function useInstructionUsage(instructionId: string | undefined, enabled = true) {
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    return useQuery<InstructionUsageResponse>({
        queryKey: [INSTRUCTION_USAGE_QUERY_KEY, instructionId],
        queryFn: async () => getInstructionUsage(await getAccessTokenSilently(), instructionId!),
        enabled: enabled && isAuthenticated && !!instructionId,
        retry: false,
    })
}

/** Who the instruction is shared with. Only its owner and editors may ask. */
export function useInstructionSharedUsers(instructionId: string | undefined, enabled: boolean) {
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    return useQuery<SearchUserResponse[]>({
        queryKey: [INSTRUCTION_SHARES_QUERY_KEY, instructionId],
        queryFn: async () => getInstructionSharedUsers(await getAccessTokenSilently(), instructionId!),
        enabled: enabled && isAuthenticated && !!instructionId,
        retry: false,
    })
}
