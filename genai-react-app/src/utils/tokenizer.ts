// src/utils/tokenizer.ts
import type {Tiktoken, TiktokenModel} from "js-tiktoken";

/**
 * Cache for loaded tokenizers (store Promise<Tiktoken> to dedupe concurrent loads)
 */
const tokenizerCache: Record<string, Promise<Tiktoken> | undefined> = {};

/**
 * Get tokenizer for model (lazy-loaded and cached).
 * NOTE: This function is strict — it does NOT fallback to another model.
 * If `model` is not a supported TiktokenModel, encodingForModel will throw.
 */
export async function getTokenizer(model: string): Promise<Tiktoken> {
    if (!model) {
        throw new Error("getTokenizer: model string is required (strict mode).");
    }

    const key = model;

    if (tokenizerCache[key]) {
        return tokenizerCache[key]!;
    }

    tokenizerCache[key] = (async () => {
        // Dynamically import to reduce bundle size
        const { encodingForModel } = await import("js-tiktoken");
        // Cast to TiktokenModel — caller is responsible for providing a valid model
        return encodingForModel(key as TiktokenModel);
    })();

    return tokenizerCache[key]!;
}

/**
 * Count tokens using the strict tokenizer loader.
 * May throw if model is unsupported.
 */
export async function countTokens(text: string, model: string): Promise<number> {
    if (!text) return 0;
    if (!model) throw new Error("countTokens: model string is required (strict mode).");

    const tokenizer = await getTokenizer(model);
    const tokens = tokenizer.encode(text);
    return tokens.length;
}

/** Optional utility to clear the tokenizer cache */
export function clearTokenizerCache(): void {
    for (const key of Object.keys(tokenizerCache)) {
        delete tokenizerCache[key];
    }
}
