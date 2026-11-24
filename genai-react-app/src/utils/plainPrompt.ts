// A prompt as one plain line, for the places that name a turn (the Outline,
// the sub-bar's crumb, the phone header): markdown's emphasis, strikethrough,
// code, heading, quote, fence and link marks dropped, whitespace runs
// collapsed. Word-internal underscores and asterisks (snake_case, 2*3) stay.
export function plainPrompt(prompt: string): string {
    return prompt
        .replace(/^\s*```.*$/gm, '')
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?)/gm, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
        .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1')
        .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, '$1')
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
}
