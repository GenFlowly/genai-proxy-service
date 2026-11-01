import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { InputSelectWithHint, InputTextWithHint, PillButton } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import {
    CustomerTool,
    CustomerToolMethod,
    CustomerToolStatus,
    DEFAULT_MAX_CHARS,
    DryRunResolvedRequest,
    DryRunResult,
    HTTP_PROVIDER,
    MANUAL_ORIGIN,
    MAX_DESCRIPTION_LENGTH,
    MAX_MAX_CHARS,
    MAX_TOOL_ARGUMENTS,
    MIN_DESCRIPTION_LENGTH,
    RESERVED_TOOL_NAMES,
    RESPONSE_TRANSFORM_MODES,
    ResponseTransformMode,
    TOOL_ARGUMENT_TYPES,
    TOOL_METHODS,
    TOOL_NAME_PATTERN,
    ToolArgumentType,
    ToolCredentialStatus,
    ToolParametersSchema,
    ToolRequestTemplate,
    ToolResponseTransform,
    UpsertCustomerToolRequest,
    deleteCustomerTool,
    dryRunCustomerTool,
    getCustomerTool,
    getToolCredentialStatuses,
    listCustomerTools,
    maskOutboundRequest,
    parseJsonField,
    referencedArgumentKeys,
    saveCustomerTool,
    storeToolCredentials,
    urlOriginIsLiteral,
} from '../../../services/customerToolsService'
import { WebSearchToolSettings } from './WebSearchToolSettings'
import styles from './ToolsSettings.module.scss'

/** Credentials stored from this page are plain secret values, not OAuth. */
const AUTH_TYPE = 'api_key'

const ARGUMENT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const CREDENTIAL_PLACEHOLDER = /\{\{\s*credential\.([a-zA-Z0-9_]+)\s*\}\}/g

/** One row of the argument builder — the user never writes JSON Schema. */
interface ArgumentDraft {
    id: string
    name: string
    type: ToolArgumentType
    required: boolean
    description: string
}

/** One row of a headers / query / body repeater. */
interface PairDraft {
    id: string
    key: string
    value: string
}

interface ToolFormDraft {
    name: string
    description: string
    args: ArgumentDraft[]
    method: CustomerToolMethod
    url: string
    headers: PairDraft[]
    query: PairDraft[]
    body: PairDraft[]
    bodyType: 'json' | 'form'
    transformMode: ResponseTransformMode
    transformPath: string
    maxChars: number
    credentialRef: string
}

let rowSequence = 0
const nextRowId = (): string => `row-${++rowSequence}`

const emptyPair = (): PairDraft => ({ id: nextRowId(), key: '', value: '' })

const emptyArgument = (): ArgumentDraft => ({
    id: nextRowId(),
    name: '',
    type: 'string',
    required: true,
    description: '',
})

const emptyDraft = (): ToolFormDraft => ({
    name: '',
    description: '',
    args: [emptyArgument()],
    method: 'GET',
    url: '',
    headers: [emptyPair()],
    query: [emptyPair()],
    body: [emptyPair()],
    bodyType: 'json',
    transformMode: 'text',
    transformPath: '',
    maxChars: DEFAULT_MAX_CHARS,
    credentialRef: '',
})

const pairsToMap = (pairs: PairDraft[]): Record<string, string> => (
    Object.fromEntries(
        pairs
            .filter(pair => pair.key.trim() !== '')
            .map(pair => [pair.key.trim(), pair.value])
    )
)

const mapToPairs = (map: Record<string, string> | null | undefined): PairDraft[] => {
    const pairs = Object.entries(map ?? {}).map(([key, value]) => ({ id: nextRowId(), key, value }))
    return pairs.length > 0 ? pairs : [emptyPair()]
}

/** The argument rows, as the restricted JSON Schema the contract stores. */
function buildParameters(args: ArgumentDraft[]): ToolParametersSchema {
    const named = args.filter(arg => arg.name.trim() !== '')
    return {
        type: 'object',
        properties: Object.fromEntries(
            named.map(arg => [
                arg.name.trim(),
                arg.description.trim()
                    ? { type: arg.type, description: arg.description.trim() }
                    : { type: arg.type },
            ])
        ),
        required: named.filter(arg => arg.required).map(arg => arg.name.trim()),
    }
}

function parametersToArguments(schema: ToolParametersSchema): ArgumentDraft[] {
    const rows = Object.entries(schema.properties ?? {}).map(([name, property]) => ({
        id: nextRowId(),
        name,
        type: property.type,
        required: (schema.required ?? []).includes(name),
        description: property.description ?? '',
    }))
    return rows.length > 0 ? rows : [emptyArgument()]
}

function buildRequest(draft: ToolFormDraft): ToolRequestTemplate {
    const body = pairsToMap(draft.body)
    const carriesBody = draft.method !== 'GET' && draft.method !== 'DELETE' && Object.keys(body).length > 0
    return {
        method: draft.method,
        url: draft.url.trim(),
        headers: pairsToMap(draft.headers),
        query: pairsToMap(draft.query),
        body: carriesBody ? body : null,
        bodyType: draft.bodyType,
    }
}

function buildResponseTransform(draft: ToolFormDraft): ToolResponseTransform {
    return draft.transformMode === 'json_path'
        ? { mode: draft.transformMode, path: draft.transformPath.trim(), maxChars: draft.maxChars }
        : { mode: draft.transformMode, maxChars: draft.maxChars }
}

/** Every `{{credential.x}}` key the call template refers to. */
function referencedCredentialKeys(template: ToolRequestTemplate): string[] {
    const source = [
        template.url,
        ...Object.values(template.headers),
        ...Object.values(template.query),
        ...Object.values(template.body ?? {}),
    ].join('\n')
    const keys: string[] = []
    let match = CREDENTIAL_PLACEHOLDER.exec(source)
    while (match !== null) {
        if (!keys.includes(match[1])) keys.push(match[1])
        match = CREDENTIAL_PLACEHOLDER.exec(source)
    }
    CREDENTIAL_PLACEHOLDER.lastIndex = 0
    return keys
}

const formatKeyValues = (map: Record<string, string>): string => (
    Object.entries(map ?? {}).map(([key, value]) => `${key}: ${value}`).join('\n')
)

/** The outbound call, laid out the way a request over the wire reads. */
function formatOutboundRequest(
    request: DryRunResolvedRequest,
    queryLabel: string,
    noBodyLabel: string
): string {
    const lines = [`${request.method} ${request.url}`]
    if (Object.keys(request.headers ?? {}).length > 0) {
        lines.push(formatKeyValues(request.headers))
    }
    if (Object.keys(request.query ?? {}).length > 0) {
        lines.push('', queryLabel, formatKeyValues(request.query))
    }
    lines.push('')
    lines.push(request.body === null || request.body === undefined
        ? noBodyLabel
        : typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body, null, 2))
    return lines.join('\n')
}

/**
 * The customer's own tools: what the assistant can call, what each call looks
 * like, and the dry run that has to succeed before a tool goes live. A tool
 * definition never holds a secret — those live in the encrypted credential
 * store and are referenced by name.
 */
export function ToolsSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { showToast } = useToast()

    const [tools, setTools] = useState<CustomerTool[]>([])
    const [credentialStatuses, setCredentialStatuses] = useState<ToolCredentialStatus[]>([])
    const [loadingList, setLoadingList] = useState(true)

    const [formOpen, setFormOpen] = useState(false)
    // Set while editing: the stored tool the form was opened from
    const [editing, setEditing] = useState<CustomerTool | null>(null)
    const [draft, setDraft] = useState<ToolFormDraft>(emptyDraft)
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

    // Secret values typed this session; they are write-only and are posted to
    // the credential store, never kept on the tool row
    const [credentialValues, setCredentialValues] = useState<Record<string, string>>({})
    const [savingCredential, setSavingCredential] = useState(false)

    const [testValues, setTestValues] = useState<Record<string, string>>({})
    const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null)
    // The dry-run endpoint's own error text, shown in place of a result
    const [dryRunError, setDryRunError] = useState<string | null>(null)
    const [dryRunning, setDryRunning] = useState(false)
    // The template the shown dry run was made from — what the masking reads
    const dryRunTemplate = useRef<ToolRequestTemplate | null>(null)

    const [saving, setSaving] = useState(false)
    const [busyToolName, setBusyToolName] = useState<string | null>(null)

    const loadTools = useCallback(async () => {
        if (!isAuthenticated || !customerId) return
        try {
            setLoadingList(true)
            const token = await getAccessTokenSilently()
            const [toolsResponse, credentialsResponse] = await Promise.all([
                listCustomerTools(token),
                getToolCredentialStatuses(token),
            ])
            setTools(toolsResponse.tools)
            setCredentialStatuses(credentialsResponse.toolCredentialStatuses)
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.toolsSettings.loadErrorToast'))
        } finally {
            setLoadingList(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    useEffect(() => {
        loadTools()
    }, [loadTools])

    const credentialConnected = useCallback((credentialRef: string) => (
        !!credentialRef && credentialStatuses.some(s => s.toolType === credentialRef && s.connected)
    ), [credentialStatuses])

    const statusLabel = (status: CustomerToolStatus) => t(`settingsPage.toolsSettings.status_${status}`)

    const requestTemplate = useMemo(() => buildRequest(draft), [draft])
    const credentialKeys = useMemo(() => referencedCredentialKeys(requestTemplate), [requestTemplate])
    const testArgumentNames = useMemo(() => {
        const declared = draft.args.map(arg => arg.name.trim()).filter(Boolean)
        // Declared arguments first, then anything the call refers to but never declared
        const all = [...declared, ...referencedArgumentKeys(requestTemplate)]
        return all.filter((argName, index) => all.indexOf(argName) === index)
    }, [draft.args, requestTemplate])

    const resetForm = () => {
        setDraft(emptyDraft())
        setEditing(null)
        setFieldErrors({})
        setCredentialValues({})
        setTestValues({})
        setDryRunResult(null)
        setDryRunError(null)
        dryRunTemplate.current = null
    }

    const handleAddTool = () => {
        resetForm()
        setFormOpen(true)
    }

    const handleEditTool = (tool: CustomerTool) => {
        const parameters = parseJsonField<ToolParametersSchema>(tool.parameters, {
            type: 'object',
            properties: {},
            required: [],
        })
        const request = parseJsonField<ToolRequestTemplate>(tool.request, {
            method: 'GET',
            url: '',
            headers: {},
            query: {},
            body: null,
            bodyType: 'json',
        })
        const transform = parseJsonField<ToolResponseTransform>(tool.responseTransform, { mode: 'text' })

        setDraft({
            name: tool.name,
            description: tool.description,
            args: parametersToArguments(parameters),
            method: request.method ?? 'GET',
            url: request.url ?? '',
            headers: mapToPairs(request.headers),
            query: mapToPairs(request.query),
            body: mapToPairs(request.body),
            bodyType: request.bodyType ?? 'json',
            transformMode: transform.mode ?? 'text',
            transformPath: transform.path ?? '',
            maxChars: transform.maxChars ?? DEFAULT_MAX_CHARS,
            credentialRef: tool.credentialRef,
        })
        setEditing(tool)
        setFieldErrors({})
        setCredentialValues({})
        setTestValues({})
        setDryRunResult(null)
        setDryRunError(null)
        dryRunTemplate.current = null
        setFormOpen(true)
    }

    const handleCloseForm = () => {
        resetForm()
        setFormOpen(false)
    }

    const updateDraft = (patch: Partial<ToolFormDraft>) => setDraft(prev => ({ ...prev, ...patch }))

    const updatePair = (
        field: 'headers' | 'query' | 'body',
        id: string,
        patch: Partial<PairDraft>
    ) => {
        setDraft(prev => ({
            ...prev,
            [field]: prev[field].map(pair => (pair.id === id ? { ...pair, ...patch } : pair)),
        }))
    }

    const addPair = (field: 'headers' | 'query' | 'body') => {
        setDraft(prev => ({ ...prev, [field]: [...prev[field], emptyPair()] }))
    }

    const removePair = (field: 'headers' | 'query' | 'body', id: string) => {
        setDraft(prev => {
            const remaining = prev[field].filter(pair => pair.id !== id)
            return { ...prev, [field]: remaining.length > 0 ? remaining : [emptyPair()] }
        })
    }

    const updateArgument = (id: string, patch: Partial<ArgumentDraft>) => {
        setDraft(prev => ({
            ...prev,
            args: prev.args.map(arg => (arg.id === id ? { ...arg, ...patch } : arg)),
        }))
    }

    const addArgument = () => {
        setDraft(prev => ({ ...prev, args: [...prev.args, emptyArgument()] }))
    }

    const removeArgument = (id: string) => {
        setDraft(prev => {
            const remaining = prev.args.filter(arg => arg.id !== id)
            return { ...prev, args: remaining.length > 0 ? remaining : [emptyArgument()] }
        })
    }

    /** The same rules the server enforces on save, so the form fails first. */
    const validate = (): Record<string, string> => {
        const errors: Record<string, string> = {}
        const name = draft.name.trim()

        if (!TOOL_NAME_PATTERN.test(name)) {
            errors.name = t('settingsPage.toolsSettings.errorNameFormat')
        } else if (RESERVED_TOOL_NAMES.includes(name)) {
            errors.name = t('settingsPage.toolsSettings.errorNameReserved', { name })
        }

        const description = draft.description.trim()
        if (description.length < MIN_DESCRIPTION_LENGTH || description.length > MAX_DESCRIPTION_LENGTH) {
            errors.description = t('settingsPage.toolsSettings.errorDescriptionLength', {
                min: MIN_DESCRIPTION_LENGTH,
                max: MAX_DESCRIPTION_LENGTH,
            })
        }

        const argNames = draft.args.map(arg => arg.name.trim()).filter(Boolean)
        if (argNames.length > MAX_TOOL_ARGUMENTS) {
            errors.args = t('settingsPage.toolsSettings.errorTooManyArguments', { max: MAX_TOOL_ARGUMENTS })
        } else if (argNames.some(argName => !ARGUMENT_NAME_PATTERN.test(argName))) {
            errors.args = t('settingsPage.toolsSettings.errorArgumentName')
        } else if (new Set(argNames).size !== argNames.length) {
            errors.args = t('settingsPage.toolsSettings.errorArgumentDuplicate')
        }

        const url = draft.url.trim()
        if (!url.toLowerCase().startsWith('https://')) {
            errors.url = t('settingsPage.toolsSettings.errorUrlHttps')
        } else if (!urlOriginIsLiteral(url)) {
            errors.url = t('settingsPage.toolsSettings.errorUrlOrigin')
        }

        if (!errors.args) {
            const unknown = referencedArgumentKeys(requestTemplate).filter(key => !argNames.includes(key))
            if (unknown.length > 0) {
                errors.args = t('settingsPage.toolsSettings.errorArgumentUnknown', { name: unknown[0] })
            }
        }

        if (draft.transformMode === 'json_path' && !draft.transformPath.trim()) {
            errors.transformPath = t('settingsPage.toolsSettings.errorPathRequired')
        }

        if (draft.maxChars < 1 || draft.maxChars > MAX_MAX_CHARS) {
            errors.maxChars = t('settingsPage.toolsSettings.errorMaxChars', { max: MAX_MAX_CHARS })
        }

        return errors
    }

    const payloadFor = (status: CustomerToolStatus): UpsertCustomerToolRequest => ({
        name: draft.name.trim(),
        description: draft.description.trim(),
        parameters: JSON.stringify(buildParameters(draft.args)),
        provider: HTTP_PROVIDER,
        request: JSON.stringify(buildRequest(draft)),
        credentialRef: draft.credentialRef.trim(),
        responseTransform: JSON.stringify(buildResponseTransform(draft)),
        status,
        origin: editing?.origin || MANUAL_ORIGIN,
        originRef: editing?.originRef ?? '',
        // The stamp the server wrote on the last successful dry run; sending it
        // back is what lets a save set `active`.
        lastDryRunAt: editing?.lastDryRunAt ?? '',
    })

    /** Sample values typed as the argument declares them. */
    const typedTestArgs = (): Record<string, unknown> => (
        Object.fromEntries(
            Object.entries(testValues).map(([key, value]) => {
                const declared = draft.args.find(arg => arg.name.trim() === key)
                if (declared?.type === 'boolean') return [key, value.trim().toLowerCase() === 'true']
                if (declared?.type === 'number' || declared?.type === 'integer') {
                    const asNumber = Number(value)
                    return [key, Number.isNaN(asNumber) ? value : asNumber]
                }
                return [key, value]
            })
        )
    )

    const requireAuth = (): boolean => {
        if (!isAuthenticated || !customerId) {
            showToast(t('settingsPage.toolsSettings.loginFirstToast'))
            return false
        }
        return true
    }

    /** Saves the draft and reports it, or null when validation stopped it. */
    const persistDraft = async (status: CustomerToolStatus): Promise<CustomerTool | null> => {
        const errors = validate()
        setFieldErrors(errors)
        if (Object.keys(errors).length > 0) {
            showToast(t('settingsPage.toolsSettings.fixFieldsToast'))
            return null
        }
        const token = await getAccessTokenSilently()
        const saved = await saveCustomerTool(token, payloadFor(status))
        setEditing(saved)
        return saved
    }

    const handleSave = async () => {
        if (!requireAuth()) return
        try {
            setSaving(true)
            // An edit keeps whatever status the tool already earned; a new
            // tool can only ever be saved as a draft.
            const saved = await persistDraft(editing?.status ?? 'draft')
            if (!saved) return
            showToast(t('settingsPage.toolsSettings.savedToast'))
            await loadTools()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.toolsSettings.saveErrorToast'))
        } finally {
            setSaving(false)
        }
    }

    /**
     * Saves the definition, then makes one real call with the test values. The
     * server records the dry run, which is what lets the tool be turned on.
     */
    const handleDryRun = async () => {
        if (!requireAuth()) return
        try {
            setDryRunning(true)
            setDryRunResult(null)
            setDryRunError(null)
            // Saved first on purpose: the server only stamps a successful dry
            // run onto a stored row, and that stamp is what unlocks `active`.
            const saved = await persistDraft(editing?.status ?? 'draft')
            if (!saved) return
            const template = buildRequest(draft)
            const token = await getAccessTokenSilently()
            const result = await dryRunCustomerTool(token, saved.name, {
                tool: payloadFor(saved.status),
                args: typedTestArgs(),
            })
            dryRunTemplate.current = template
            setDryRunResult(result)
            if (result.ok) {
                // Pick up the stamp the dry run just wrote
                setEditing(await getCustomerTool(token, saved.name))
            }
            await loadTools()
        } catch (error: any) {
            console.error(error)
            // The endpoint may not be reachable yet — show what the server said
            setDryRunError(error.message || t('settingsPage.toolsSettings.dryRunErrorToast'))
        } finally {
            setDryRunning(false)
        }
    }

    const canActivate = !!dryRunResult?.ok || !!editing?.lastDryRunAt

    const handleSetStatus = async (status: CustomerToolStatus) => {
        if (!requireAuth()) return
        try {
            setSaving(true)
            const saved = await persistDraft(status)
            if (!saved) return
            showToast(status === 'active'
                ? t('settingsPage.toolsSettings.activatedToast')
                : t('settingsPage.toolsSettings.disabledToast'))
            await loadTools()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.toolsSettings.saveErrorToast'))
        } finally {
            setSaving(false)
        }
    }

    const handleSaveCredential = async () => {
        if (!requireAuth()) return
        const credentialRef = (draft.credentialRef.trim() || draft.name.trim())
        const values = Object.fromEntries(
            credentialKeys
                .map(key => [key, credentialValues[key] ?? ''])
                .filter(([, value]) => value !== '')
        )
        if (!credentialRef || Object.keys(values).length === 0) {
            showToast(t('settingsPage.toolsSettings.credentialValuesRequiredToast'))
            return
        }
        try {
            setSavingCredential(true)
            const token = await getAccessTokenSilently()
            await storeToolCredentials(token, {
                toolType: credentialRef,
                authType: AUTH_TYPE,
                credentials: values,
            })
            updateDraft({ credentialRef })
            setCredentialValues({})
            showToast(t('settingsPage.toolsSettings.credentialSavedToast'))
            await loadTools()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.toolsSettings.credentialErrorToast'))
        } finally {
            setSavingCredential(false)
        }
    }

    const handleDelete = async (tool: CustomerTool) => {
        if (!window.confirm(t('settingsPage.toolsSettings.deleteConfirm', { name: tool.name }))) {
            return
        }
        try {
            setBusyToolName(tool.name)
            const token = await getAccessTokenSilently()
            await deleteCustomerTool(token, tool.name)
            if (editing?.name === tool.name) handleCloseForm()
            showToast(t('settingsPage.toolsSettings.deletedToast'))
            await loadTools()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.toolsSettings.deleteErrorToast'))
        } finally {
            setBusyToolName(null)
        }
    }

    const maskedRequest = dryRunResult?.request && dryRunTemplate.current
        ? maskOutboundRequest(dryRunResult.request, dryRunTemplate.current)
        : null

    const renderPairRows = (field: 'headers' | 'query' | 'body', testIdPrefix: string) => (
        <div className={styles.repeater}>
            {draft[field].map(pair => (
                <div key={pair.id} className={styles.pairRow}>
                    <input
                        className={styles.cellInput}
                        aria-label={t('settingsPage.toolsSettings.keyColumn')}
                        placeholder={t('settingsPage.toolsSettings.keyColumn')}
                        value={pair.key}
                        onChange={e => updatePair(field, pair.id, { key: e.target.value })}
                        data-testid={`${testIdPrefix}-key-${pair.id}`}
                    />
                    <input
                        className={styles.cellInput}
                        aria-label={t('settingsPage.toolsSettings.valueColumn')}
                        placeholder={t('settingsPage.toolsSettings.valueColumn')}
                        value={pair.value}
                        onChange={e => updatePair(field, pair.id, { value: e.target.value })}
                        data-testid={`${testIdPrefix}-value-${pair.id}`}
                    />
                    <button
                        type="button"
                        className={styles.removeButton}
                        onClick={() => removePair(field, pair.id)}
                        aria-label={t('settingsPage.toolsSettings.removeRow')}
                    >
                        ×
                    </button>
                </div>
            ))}
            <button type="button" className={styles.addRowButton} onClick={() => addPair(field)}>
                {t('settingsPage.toolsSettings.addRow')}
            </button>
        </div>
    )

    return (
        <div className={styles.container}>
            <div className={styles.listSection}>
                <div className={styles.listHeader}>
                    <h3 className={styles.listTitle}>{t('settingsPage.toolsSettings.builtInTitle')}</h3>
                </div>
                <p className={styles.subtitle}>{t('settingsPage.toolsSettings.builtInSubtitle')}</p>
                <WebSearchToolSettings
                    connected={credentialConnected('WEB_SEARCH')}
                    settings={credentialStatuses.find(s => s.toolType === 'WEB_SEARCH')?.settings ?? null}
                    getAccessTokenSilently={getAccessTokenSilently}
                    onChanged={loadTools}
                />
            </div>

            <div className={styles.listSection}>
                <div className={styles.listHeader}>
                    <h3 className={styles.listTitle}>{t('settingsPage.toolsSettings.yourTools')}</h3>
                    <PillButton
                        onClick={handleAddTool}
                        label={t('settingsPage.toolsSettings.addTool')}
                        icon={ICONS.PLUS}
                        data-testid="add-tool"
                    />
                </div>

                {loadingList ? (
                    <p className={styles.emptyState}>{t('settingsPage.toolsSettings.loading')}</p>
                ) : tools.length === 0 ? (
                    <p className={styles.emptyState}>{t('settingsPage.toolsSettings.noToolsYet')}</p>
                ) : (
                    <div className={styles.toolList}>
                        {tools.map(tool => (
                            <div key={tool.name} className={styles.toolRow} data-testid={`tool-row-${tool.name}`}>
                                <div className={styles.toolInfo}>
                                    <span className={styles.toolName}>{tool.name}</span>
                                    <span className={styles.toolDescription}>{tool.description}</span>
                                </div>
                                <div className={styles.toolPills}>
                                    <span className={`${styles.pill} ${styles[`pill_${tool.status}`]}`}>
                                        {statusLabel(tool.status)}
                                    </span>
                                    <span className={styles.pill}>
                                        {credentialConnected(tool.credentialRef)
                                            ? t('settingsPage.toolsSettings.credentialConnected')
                                            : t('settingsPage.toolsSettings.credentialMissing')}
                                    </span>
                                </div>
                                <div className={styles.toolActions}>
                                    <PillButton
                                        onClick={() => handleEditTool(tool)}
                                        label={t('settingsPage.toolsSettings.edit')}
                                        variant="secondary"
                                        data-testid={`edit-tool-${tool.name}`}
                                    />
                                    <PillButton
                                        onClick={() => handleDelete(tool)}
                                        label={busyToolName === tool.name
                                            ? t('settingsPage.toolsSettings.deletingLabel')
                                            : t('settingsPage.toolsSettings.delete')}
                                        variant="danger"
                                        disabled={busyToolName === tool.name}
                                        data-testid={`delete-tool-${tool.name}`}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {formOpen && (
                <div className={styles.form} data-testid="tool-form">
                    <h3 className={styles.formTitle}>
                        {editing
                            ? t('settingsPage.toolsSettings.formTitleEdit', { name: editing.name })
                            : t('settingsPage.toolsSettings.formTitleNew')}
                    </h3>

                    <section className={styles.section}>
                        <h4 className={styles.sectionTitle}>{t('settingsPage.toolsSettings.basicsTitle')}</h4>
                        <InputTextWithHint
                            hint={t('settingsPage.toolsSettings.nameHint')}
                            value={draft.name}
                            onChange={e => updateDraft({ name: e.target.value })}
                            placeholder={t('settingsPage.toolsSettings.namePlaceholder')}
                            disabled={!!editing}
                        />
                        {fieldErrors.name
                            ? <p className={styles.fieldError} data-testid="tool-name-error">{fieldErrors.name}</p>
                            : <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.nameHelp')}</p>}

                        <InputTextWithHint
                            hint={t('settingsPage.toolsSettings.descriptionHint')}
                            value={draft.description}
                            onChange={e => updateDraft({ description: e.target.value })}
                            placeholder={t('settingsPage.toolsSettings.descriptionPlaceholder')}
                        />
                        {fieldErrors.description
                            ? <p className={styles.fieldError} data-testid="tool-description-error">{fieldErrors.description}</p>
                            : <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.descriptionHelp')}</p>}
                    </section>

                    <section className={styles.section}>
                        <h4 className={styles.sectionTitle}>{t('settingsPage.toolsSettings.argumentsTitle')}</h4>
                        <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.argumentsHelp')}</p>
                        <div className={styles.repeater}>
                            {draft.args.map(arg => (
                                <div key={arg.id} className={styles.argumentRow}>
                                    <input
                                        className={styles.cellInput}
                                        aria-label={t('settingsPage.toolsSettings.argName')}
                                        placeholder={t('settingsPage.toolsSettings.argName')}
                                        value={arg.name}
                                        onChange={e => updateArgument(arg.id, { name: e.target.value })}
                                        data-testid={`argument-name-${arg.id}`}
                                    />
                                    <select
                                        className={styles.cellSelect}
                                        aria-label={t('settingsPage.toolsSettings.argType')}
                                        value={arg.type}
                                        onChange={e => updateArgument(arg.id, { type: e.target.value as ToolArgumentType })}
                                        data-testid={`argument-type-${arg.id}`}
                                    >
                                        {TOOL_ARGUMENT_TYPES.map(type => (
                                            <option key={type} value={type}>
                                                {t(`settingsPage.toolsSettings.argType_${type}`)}
                                            </option>
                                        ))}
                                    </select>
                                    <label className={styles.checkboxLabel}>
                                        <input
                                            type="checkbox"
                                            checked={arg.required}
                                            onChange={e => updateArgument(arg.id, { required: e.target.checked })}
                                            data-testid={`argument-required-${arg.id}`}
                                        />
                                        <span>{t('settingsPage.toolsSettings.argRequired')}</span>
                                    </label>
                                    <input
                                        className={styles.cellInput}
                                        aria-label={t('settingsPage.toolsSettings.argDescription')}
                                        placeholder={t('settingsPage.toolsSettings.argDescription')}
                                        value={arg.description}
                                        onChange={e => updateArgument(arg.id, { description: e.target.value })}
                                        data-testid={`argument-description-${arg.id}`}
                                    />
                                    <button
                                        type="button"
                                        className={styles.removeButton}
                                        onClick={() => removeArgument(arg.id)}
                                        aria-label={t('settingsPage.toolsSettings.removeRow')}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                            <button type="button" className={styles.addRowButton} onClick={addArgument}>
                                {t('settingsPage.toolsSettings.addArgument')}
                            </button>
                        </div>
                        {fieldErrors.args && (
                            <p className={styles.fieldError} data-testid="tool-arguments-error">{fieldErrors.args}</p>
                        )}
                    </section>

                    <section className={styles.section}>
                        <h4 className={styles.sectionTitle}>{t('settingsPage.toolsSettings.callTitle')}</h4>
                        <div className={styles.callRow}>
                            <InputSelectWithHint
                                hint={t('settingsPage.toolsSettings.methodHint')}
                                value={draft.method}
                                onChange={(value: string) => updateDraft({ method: value as CustomerToolMethod })}
                                options={TOOL_METHODS.map(method => ({ label: method, value: method }))}
                                data-testid="tool-method"
                            />
                            <InputTextWithHint
                                hint={t('settingsPage.toolsSettings.urlHint')}
                                value={draft.url}
                                onChange={e => updateDraft({ url: e.target.value })}
                                placeholder={t('settingsPage.toolsSettings.urlPlaceholder')}
                            />
                        </div>
                        {fieldErrors.url
                            ? <p className={styles.fieldError} data-testid="tool-url-error">{fieldErrors.url}</p>
                            : <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.urlHelp')}</p>}

                        <h5 className={styles.subsectionTitle}>{t('settingsPage.toolsSettings.headersTitle')}</h5>
                        {renderPairRows('headers', 'header')}

                        <h5 className={styles.subsectionTitle}>{t('settingsPage.toolsSettings.queryTitle')}</h5>
                        {renderPairRows('query', 'query')}

                        <h5 className={styles.subsectionTitle}>{t('settingsPage.toolsSettings.bodyTitle')}</h5>
                        {renderPairRows('body', 'body')}
                        <InputSelectWithHint
                            hint={t('settingsPage.toolsSettings.bodyTypeHint')}
                            value={draft.bodyType}
                            onChange={(value: string) => updateDraft({ bodyType: value as 'json' | 'form' })}
                            options={[
                                { label: t('settingsPage.toolsSettings.bodyTypeJson'), value: 'json' },
                                { label: t('settingsPage.toolsSettings.bodyTypeForm'), value: 'form' },
                            ]}
                            data-testid="tool-body-type"
                        />
                    </section>

                    <section className={styles.section}>
                        <h4 className={styles.sectionTitle}>{t('settingsPage.toolsSettings.responseTitle')}</h4>
                        <InputSelectWithHint
                            hint={t('settingsPage.toolsSettings.transformModeHint')}
                            value={draft.transformMode}
                            onChange={(value: string) => updateDraft({ transformMode: value as ResponseTransformMode })}
                            options={RESPONSE_TRANSFORM_MODES.map(mode => ({
                                label: t(`settingsPage.toolsSettings.transformMode_${mode}`),
                                value: mode,
                            }))}
                            data-testid="tool-transform-mode"
                        />
                        {draft.transformMode === 'json_path' && (
                            <>
                                <InputTextWithHint
                                    hint={t('settingsPage.toolsSettings.transformPathHint')}
                                    value={draft.transformPath}
                                    onChange={e => updateDraft({ transformPath: e.target.value })}
                                    placeholder={t('settingsPage.toolsSettings.transformPathPlaceholder')}
                                />
                                {fieldErrors.transformPath
                                    ? <p className={styles.fieldError}>{fieldErrors.transformPath}</p>
                                    : <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.transformPathHelp')}</p>}
                            </>
                        )}
                        <label className={styles.numberField}>
                            <span className={styles.fieldLabel}>{t('settingsPage.toolsSettings.maxCharsHint')}</span>
                            <input
                                className={styles.cellInput}
                                type="number"
                                min={1}
                                max={MAX_MAX_CHARS}
                                value={draft.maxChars}
                                onChange={e => updateDraft({ maxChars: Number(e.target.value) })}
                                data-testid="tool-max-chars"
                            />
                        </label>
                        {fieldErrors.maxChars
                            ? <p className={styles.fieldError}>{fieldErrors.maxChars}</p>
                            : <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.maxCharsHelp')}</p>}
                    </section>

                    <section className={styles.section}>
                        <h4 className={styles.sectionTitle}>{t('settingsPage.toolsSettings.credentialTitle')}</h4>
                        {credentialKeys.length === 0 ? (
                            <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.credentialNoneHelp')}</p>
                        ) : (
                            <>
                                <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.credentialHelp')}</p>
                                <InputTextWithHint
                                    hint={t('settingsPage.toolsSettings.credentialNameHint')}
                                    value={draft.credentialRef}
                                    onChange={e => updateDraft({ credentialRef: e.target.value })}
                                    placeholder={draft.name.trim() || t('settingsPage.toolsSettings.credentialNamePlaceholder')}
                                />
                                {credentialKeys.map(key => (
                                    <label key={key} className={styles.credentialField}>
                                        <span className={styles.fieldLabel}>{key}</span>
                                        <input
                                            className={styles.cellInput}
                                            type="password"
                                            autoComplete="off"
                                            value={credentialValues[key] ?? ''}
                                            onChange={e => setCredentialValues(prev => ({ ...prev, [key]: e.target.value }))}
                                            placeholder={t('settingsPage.toolsSettings.credentialValuePlaceholder')}
                                            data-testid={`credential-value-${key}`}
                                        />
                                    </label>
                                ))}
                                <div className={styles.sectionFooter}>
                                    <PillButton
                                        onClick={handleSaveCredential}
                                        label={savingCredential
                                            ? t('settingsPage.toolsSettings.savingLabel')
                                            : t('settingsPage.toolsSettings.saveCredential')}
                                        icon={ICONS.SAVE_ICON}
                                        variant="secondary"
                                        disabled={savingCredential}
                                        data-testid="save-credential"
                                    />
                                </div>
                            </>
                        )}
                    </section>

                    <section className={`${styles.section} ${styles.dryRunSection}`}>
                        <h4 className={styles.sectionTitle}>{t('settingsPage.toolsSettings.testValuesTitle')}</h4>
                        <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.testValuesHelp')}</p>
                        {testArgumentNames.length === 0 ? (
                            <p className={styles.fieldHelp}>{t('settingsPage.toolsSettings.testValuesNone')}</p>
                        ) : (
                            testArgumentNames.map(argName => (
                                <label key={argName} className={styles.testValueField}>
                                    <span className={styles.fieldLabel}>{argName}</span>
                                    <input
                                        className={styles.cellInput}
                                        value={testValues[argName] ?? ''}
                                        onChange={e => setTestValues(prev => ({ ...prev, [argName]: e.target.value }))}
                                        data-testid={`test-value-${argName}`}
                                    />
                                </label>
                            ))
                        )}
                        <div className={styles.dryRunFooter}>
                            <PillButton
                                onClick={handleDryRun}
                                label={dryRunning
                                    ? t('settingsPage.toolsSettings.dryRunningLabel')
                                    : t('settingsPage.toolsSettings.dryRun')}
                                icon={ICONS.SEND}
                                disabled={dryRunning}
                                data-testid="dry-run"
                            />
                            <span className={styles.dryRunHelp}>{t('settingsPage.toolsSettings.dryRunHelp')}</span>
                        </div>

                        {dryRunError && (
                            <div className={styles.dryRunError} data-testid="dry-run-error">
                                <p className={styles.dryRunErrorTitle}>{t('settingsPage.toolsSettings.dryRunErrorTitle')}</p>
                                <p className={styles.dryRunErrorDetail}>{dryRunError}</p>
                            </div>
                        )}

                        {dryRunResult && (
                            <div className={styles.dryRunPanel} data-testid="dry-run-panel">
                                <p className={dryRunResult.ok ? styles.dryRunOk : styles.dryRunFailed}>
                                    {dryRunResult.ok
                                        ? t('settingsPage.toolsSettings.dryRunSucceeded', {
                                            status: dryRunResult.response?.status_code ?? '',
                                        })
                                        : t('settingsPage.toolsSettings.dryRunFailed', {
                                            status: dryRunResult.response?.status_code ?? '',
                                        })}
                                </p>
                                {dryRunResult.error && (
                                    <p className={styles.dryRunErrorDetail}>{dryRunResult.error}</p>
                                )}

                                <div className={styles.dryRunBlock}>
                                    <h5 className={styles.dryRunBlockTitle}>
                                        {t('settingsPage.toolsSettings.outboundTitle')}
                                    </h5>
                                    <p className={styles.dryRunNote}>{t('settingsPage.toolsSettings.outboundMaskNote')}</p>
                                    <pre className={styles.codeBlock} data-testid="dry-run-request">
                                        {maskedRequest
                                            ? formatOutboundRequest(
                                                maskedRequest,
                                                t('settingsPage.toolsSettings.queryTitle'),
                                                t('settingsPage.toolsSettings.noBody')
                                            )
                                            : t('settingsPage.toolsSettings.outboundMissing')}
                                    </pre>
                                </div>

                                <div className={styles.dryRunBlock}>
                                    <h5 className={styles.dryRunBlockTitle}>
                                        {t('settingsPage.toolsSettings.rawResponseTitle')}
                                    </h5>
                                    <pre className={styles.codeBlock} data-testid="dry-run-response">
                                        {dryRunResult.response?.body ?? ''}
                                    </pre>
                                    {dryRunResult.response?.truncated && (
                                        <p className={styles.dryRunNote}>{t('settingsPage.toolsSettings.rawTruncated')}</p>
                                    )}
                                </div>

                                <div className={styles.dryRunBlock}>
                                    <h5 className={styles.dryRunBlockTitle}>
                                        {t('settingsPage.toolsSettings.modelTextTitle')}
                                    </h5>
                                    <pre className={`${styles.codeBlock} ${styles.modelTextBlock}`} data-testid="dry-run-model-text">
                                        {dryRunResult.model_sees ?? ''}
                                    </pre>
                                    <p className={styles.dryRunNote}>
                                        {t('settingsPage.toolsSettings.modelTextChars', {
                                            chars: (dryRunResult.model_sees ?? '').length,
                                        })}
                                    </p>
                                </div>
                            </div>
                        )}
                    </section>

                    <div className={styles.formFooter}>
                        <PillButton
                            onClick={handleSave}
                            label={saving
                                ? t('settingsPage.toolsSettings.savingLabel')
                                : t('settingsPage.toolsSettings.save')}
                            icon={ICONS.SAVE_ICON}
                            disabled={saving || dryRunning}
                            data-testid="save-tool"
                        />
                        {editing?.status === 'active' ? (
                            <PillButton
                                onClick={() => handleSetStatus('disabled')}
                                label={t('settingsPage.toolsSettings.disable')}
                                variant="secondary"
                                disabled={saving || dryRunning}
                                data-testid="disable-tool"
                            />
                        ) : (
                            <PillButton
                                onClick={() => handleSetStatus('active')}
                                label={t('settingsPage.toolsSettings.activate')}
                                variant="secondary"
                                disabled={!canActivate || saving || dryRunning}
                                data-testid="activate-tool"
                            />
                        )}
                        <PillButton
                            onClick={handleCloseForm}
                            label={t('settingsPage.toolsSettings.cancel')}
                            variant="secondary"
                            disabled={saving || dryRunning}
                            data-testid="cancel-tool-form"
                        />
                        {!canActivate && (
                            <span className={styles.dryRunHelp}>{t('settingsPage.toolsSettings.activateHelp')}</span>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
