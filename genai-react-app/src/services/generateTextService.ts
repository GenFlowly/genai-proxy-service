import {HttpMethod} from "../constants/http";
import {endpoints} from "../config/endpoints";
import {
    GenerateTextRequest,
    GenerateTextResponse
} from "../models/generateText.models";

export async function generateText(
    token: string,
    request: GenerateTextRequest
): Promise<any> {
    const response = await fetch(endpoints.generateText, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
    })

    if (!response.ok) {
        throw new Error(`Text generation failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as GenerateTextResponse
}

