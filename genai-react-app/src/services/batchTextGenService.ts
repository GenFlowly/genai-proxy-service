// src/services/batchTextGenService.ts
import { HttpMethod } from "../constants/http"
import { endpoints } from "../config/endpoints"

interface GenerateTextRequest {
    vendor: string
    model: string
    prompt: string
    customerId: string
}

interface GenerateTextResponse {
    text: string
    vendor: string
}

interface BatchGenerateTextRequest {
    requests: GenerateTextRequest[]
}

interface BatchGenerateTextResponse {
    results: GenerateTextResponse[]
}

export async function batchGenerateText(
    token: string,
    batchRequest: BatchGenerateTextRequest
): Promise<BatchGenerateTextResponse> {
    const response = await fetch(endpoints.batchGenerateText, {
        method: HttpMethod.POST,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(batchRequest),
    })

    if (!response.ok) {
        throw new Error(`Batch text generation failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as BatchGenerateTextResponse
}
