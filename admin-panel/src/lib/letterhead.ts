// The PDF letterhead a TOOL_EXECUTOR node gives generate_pdf (plan 6.1/6.2):
// config.tool_settings.generate_pdf, in the snake_case wire shape the
// retrieval-server reads. The proxy validates the same rules on save
// (GraphValidationService rule 12).

export const PAGE_SIZES = ['A4', 'Letter', 'Legal'] as const
export type PageSize = (typeof PAGE_SIZES)[number]

export interface PdfLetterhead {
    default_page_size?: PageSize
    company_name?: string
    footer_text?: string
    accent_color?: string
    logo_attachment_id?: string
}

export const COMPANY_NAME_MAX = 120
export const FOOTER_TEXT_MAX = 200
export const LOGO_MAX_BYTES = 2 * 1024 * 1024
export const LOGO_MEDIA_TYPES = ['image/png', 'image/jpeg']

const ACCENT_COLOR = /^#[0-9A-Fa-f]{6}$/
const LOGO_ID = /^[A-Za-z0-9-]{8,64}$/

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConfig(config: string): JsonObject {
    try {
        const parsed: unknown = JSON.parse(config || '{}')
        return isObject(parsed) ? parsed : {}
    } catch {
        return {}
    }
}

/** The node's letterhead settings; unknown or malformed values are dropped. */
export function readLetterhead(config: string): PdfLetterhead {
    const toolSettings = parseConfig(config).tool_settings
    const pdf = isObject(toolSettings) ? toolSettings.generate_pdf : undefined
    if (!isObject(pdf)) return {}
    const settings: PdfLetterhead = {}
    const pageSize = pdf.default_page_size
    if (typeof pageSize === 'string' && (PAGE_SIZES as readonly string[]).includes(pageSize)) {
        settings.default_page_size = pageSize as PageSize
    }
    for (const key of ['company_name', 'footer_text', 'accent_color', 'logo_attachment_id'] as const) {
        const value = pdf[key]
        if (typeof value === 'string' && value !== '') settings[key] = value
    }
    return settings
}

/**
 * The config with its letterhead replaced by `settings`. Every other key of
 * the config (and of tool_settings) is kept; empty values are removed, and so
 * are tool_settings.generate_pdf and tool_settings once they are empty.
 */
export function writeLetterhead(config: string, settings: PdfLetterhead): string {
    const parsed = parseConfig(config)
    const pdf: JsonObject = {}
    for (const [key, value] of Object.entries(settings)) {
        const text = typeof value === 'string' ? value.trim() : value
        if (text) pdf[key] = text
    }
    const toolSettings: JsonObject = isObject(parsed.tool_settings) ? { ...parsed.tool_settings } : {}
    if (Object.keys(pdf).length > 0) {
        toolSettings.generate_pdf = pdf
    } else {
        delete toolSettings.generate_pdf
    }
    const next: JsonObject = { ...parsed }
    if (Object.keys(toolSettings).length > 0) {
        next.tool_settings = toolSettings
    } else {
        delete next.tool_settings
    }
    return JSON.stringify(next)
}

/** The first problem with `settings`, or null (same rules as the proxy). */
export function letterheadProblem(settings: PdfLetterhead): string | null {
    const company = settings.company_name?.trim() ?? ''
    if (company.length > COMPANY_NAME_MAX) {
        return `Company name must be at most ${COMPANY_NAME_MAX} characters.`
    }
    const footer = settings.footer_text?.trim() ?? ''
    if (footer.length > FOOTER_TEXT_MAX) {
        return `Footer text must be at most ${FOOTER_TEXT_MAX} characters.`
    }
    if (settings.accent_color && !ACCENT_COLOR.test(settings.accent_color)) {
        return 'Accent colour must look like #1F4E79.'
    }
    if (settings.logo_attachment_id && !LOGO_ID.test(settings.logo_attachment_id)) {
        return 'The logo id is not valid; upload the logo again.'
    }
    return null
}

/** Why a chosen logo file cannot be used, or null. */
export function logoFileProblem(file: { type: string; size: number }): string | null {
    if (!LOGO_MEDIA_TYPES.includes(file.type)) return 'The logo must be a PNG or JPEG image.'
    if (file.size > LOGO_MAX_BYTES) return 'The logo must be at most 2 MB.'
    if (file.size < 1) return 'The logo file is empty.'
    return null
}
