
export interface FetchRetryOptions extends RequestInit {
    retries?: number;
    backoff?: number; // Initial backoff in ms
    retryOn?: number[]; // status codes to retry on
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF = 1000;
const DEFAULT_RETRY_ON = [429, 500, 502, 503, 504];

/**
 * Wrapper around fetch that implements exponential backoff retry logic.
 */
export async function fetchWithRetry(url: string, options: FetchRetryOptions = {}): Promise<Response> {
    const {
        retries = DEFAULT_RETRIES,
        backoff = DEFAULT_BACKOFF,
        retryOn = DEFAULT_RETRY_ON,
        ...fetchOptions
    } = options;

    let attempt = 0;

    while (attempt <= retries) {
        try {
            const response = await fetch(url, fetchOptions);

            if (response.ok) {
                return response;
            }

            // check if status is in retryOn list
            if (retryOn.includes(response.status)) {
                if (attempt < retries) {
                    const delay = backoff * Math.pow(2, attempt);
                    console.warn(`Request failed with status ${response.status}. Retrying in ${delay}ms (Attempt ${attempt + 1}/${retries})...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    attempt++;
                    continue;
                }
            }

            // If not retryable or retries exhausted, return response (caller handles error)
            return response;

        } catch (error) {
            // Network errors (fetch throws) are also candidates for retry
            if (attempt < retries) {
                const delay = backoff * Math.pow(2, attempt);
                console.warn(`Request failed with network error. Retrying in ${delay}ms (Attempt ${attempt + 1}/${retries})...`, error);
                await new Promise(resolve => setTimeout(resolve, delay));
                attempt++;
                continue;
            }
            throw error;
        }
    }

    throw new Error('Unreachable code reached in fetchWithRetry');
}
