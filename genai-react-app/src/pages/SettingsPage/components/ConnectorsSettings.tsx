import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { InputTextWithHint, PillButton } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { storeToolCredentials } from '../../../services/customerToolsService'
import {
    Connector,
    ConnectorKind,
    DEFAULT_SPEC_CREDENTIAL_KEY,
    MAX_IMPORTED_OPERATIONS,
    MCP_AUTH_HEADERS,
    MCP_CREDENTIAL_KEY,
    McpDiscoveryResult,
    SpecPreviewResult,
    connectMcpConnector,
    credentialKeysForOperations,
    disconnectConnector,
    discoverMcpConnector,
    importSpecConnector,
    listConnectors,
    previewSpecConnector,
    suggestedCredentialRef,
} from '../../../services/connectorsService'
import styles from './ConnectorsSettings.module.scss'

/** Credentials stored from this page are plain secret values, not OAuth. */
const AUTH_TYPE = 'api_key'

/** Where imported drafts land, so the page can point at them. */
const TOOLS_PATH = '/settings/tools'

const isHttps = (url: string): boolean => url.trim().toLowerCase().startsWith('https://')

/**
 * Connectors: one thing connected, many tools out of it. Both flows are two
 * steps, and the second step is the point — the customer sees exactly what
 * they are about to get and says yes to it. The first step writes nothing.
 *
 * Secret values are posted to the credential store and referenced by name; a
 * connector request never carries one.
 */
export function ConnectorsSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { showToast } = useToast()

    const [connectors, setConnectors] = useState<Connector[]>([])
    const [loadingList, setLoadingList] = useState(true)
    const [busyConnectorId, setBusyConnectorId] = useState<string | null>(null)

    // null = neither the chooser nor a flow is open
    const [chooserOpen, setChooserOpen] = useState(false)
    const [flow, setFlow] = useState<ConnectorKind | null>(null)

    const [url, setUrl] = useState('')
    const [credentialRef, setCredentialRef] = useState('')
    // Typed this session only: write-only, posted to the credential store and
    // then dropped — it is never held alongside what it unlocks
    const [secret, setSecret] = useState('')
    const [urlError, setUrlError] = useState<string | null>(null)

    // Step two of the spec flow
    const [preview, setPreview] = useState<SpecPreviewResult | null>(null)
    const [previewError, setPreviewError] = useState<string | null>(null)
    const [previewing, setPreviewing] = useState(false)
    const [selected, setSelected] = useState<string[]>([])
    const [importing, setImporting] = useState(false)
    // Set once the import went through: how many drafts it created
    const [imported, setImported] = useState<number | null>(null)

    // Step two of the server flow
    const [discovery, setDiscovery] = useState<McpDiscoveryResult | null>(null)
    const [discoverError, setDiscoverError] = useState<string | null>(null)
    const [discovering, setDiscovering] = useState(false)
    const [label, setLabel] = useState('')
    const [connecting, setConnecting] = useState(false)

    const loadConnectors = useCallback(async () => {
        if (!isAuthenticated || !customerId) return
        try {
            setLoadingList(true)
            const token = await getAccessTokenSilently()
            const response = await listConnectors(token)
            setConnectors(response.connectors)
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.connectorsSettings.loadErrorToast'))
        } finally {
            setLoadingList(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    useEffect(() => {
        loadConnectors()
    }, [loadConnectors])

    const resetFlow = () => {
        setUrl('')
        setCredentialRef('')
        setSecret('')
        setUrlError(null)
        setPreview(null)
        setPreviewError(null)
        setSelected([])
        setImported(null)
        setDiscovery(null)
        setDiscoverError(null)
        setLabel('')
    }

    const handleAddConnector = () => {
        resetFlow()
        setFlow(null)
        setChooserOpen(true)
    }

    const handleChooseFlow = (kind: ConnectorKind) => {
        resetFlow()
        setChooserOpen(false)
        setFlow(kind)
    }

    const handleCloseFlow = () => {
        resetFlow()
        setChooserOpen(false)
        setFlow(null)
    }

    const requireAuth = (): boolean => {
        if (!isAuthenticated || !customerId) {
            showToast(t('settingsPage.connectorsSettings.loginFirstToast'))
            return false
        }
        return true
    }

    /** The address is checked here so a bad one never leaves the browser. */
    const validateUrl = (): boolean => {
        if (!url.trim()) {
            setUrlError(t('settingsPage.connectorsSettings.errorUrlRequired'))
            return false
        }
        if (!isHttps(url)) {
            setUrlError(t('settingsPage.connectorsSettings.errorUrlHttps'))
            return false
        }
        setUrlError(null)
        return true
    }

    /** What the key is filed under: what was typed, else one from the address. */
    const effectiveCredentialRef = (): string => (
        credentialRef.trim() || suggestedCredentialRef(url.trim())
    )

    const handlePreview = async () => {
        if (!requireAuth() || !validateUrl()) return
        try {
            setPreviewing(true)
            setPreview(null)
            setPreviewError(null)
            setSelected([])
            setImported(null)
            const token = await getAccessTokenSilently()
            // The key is not needed to read a description, and the preview
            // writes nothing, so it is stored at import time instead.
            const result = await previewSpecConnector(token, {
                specUrl: url.trim(),
                credentialRef: effectiveCredentialRef(),
            })
            if (!result.ok) {
                setPreviewError(result.error || t('settingsPage.connectorsSettings.previewErrorToast'))
                return
            }
            setPreview(result)
        } catch (error: any) {
            console.error(error)
            setPreviewError(error.message || t('settingsPage.connectorsSettings.previewErrorToast'))
        } finally {
            setPreviewing(false)
        }
    }

    const toggleOperation = (name: string) => {
        setSelected(prev => (
            prev.includes(name)
                ? prev.filter(selectedName => selectedName !== name)
                : prev.length >= MAX_IMPORTED_OPERATIONS ? prev : [...prev, name]
        ))
    }

    const handleImport = async () => {
        if (!requireAuth() || !preview) return
        const operations = preview.operations.filter(operation => selected.includes(operation.name))
        if (operations.length === 0 || operations.length > MAX_IMPORTED_OPERATIONS) return
        const ref = effectiveCredentialRef()
        try {
            setImporting(true)
            const token = await getAccessTokenSilently()
            if (secret.trim()) {
                // Filed under exactly the names the chosen calls will look for,
                // so the drafts resolve without the customer naming any of them
                const keys = credentialKeysForOperations(operations)
                const names = keys.length > 0 ? keys : [DEFAULT_SPEC_CREDENTIAL_KEY]
                await storeToolCredentials(token, {
                    toolType: ref,
                    authType: AUTH_TYPE,
                    credentials: Object.fromEntries(names.map(key => [key, secret.trim()])),
                })
                setSecret('')
            }
            const result = await importSpecConnector(token, {
                specUrl: url.trim(),
                credentialRef: ref,
                operations,
            })
            setImported(result.tools.length)
            showToast(t('settingsPage.connectorsSettings.importedToast', { count: result.tools.length }))
            await loadConnectors()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.connectorsSettings.importErrorToast'))
        } finally {
            setImporting(false)
        }
    }

    const handleDiscover = async () => {
        if (!requireAuth() || !validateUrl()) return
        const ref = effectiveCredentialRef()
        try {
            setDiscovering(true)
            setDiscovery(null)
            setDiscoverError(null)
            const token = await getAccessTokenSilently()
            // Stored first: the server is asked with the key in place, and the
            // request below names the key rather than carrying it
            if (secret.trim()) {
                await storeToolCredentials(token, {
                    toolType: ref,
                    authType: AUTH_TYPE,
                    credentials: { [MCP_CREDENTIAL_KEY]: secret.trim() },
                })
                setSecret('')
            }
            const result = await discoverMcpConnector(token, {
                serverUrl: url.trim(),
                credentialRef: ref,
                headers: MCP_AUTH_HEADERS,
            })
            if (!result.ok) {
                setDiscoverError(result.error || t('settingsPage.connectorsSettings.discoverErrorToast'))
                return
            }
            setDiscovery(result)
            setLabel(result.server_name)
        } catch (error: any) {
            console.error(error)
            setDiscoverError(error.message || t('settingsPage.connectorsSettings.discoverErrorToast'))
        } finally {
            setDiscovering(false)
        }
    }

    /** Saves the list exactly as it was approved. Nothing else is ever bound. */
    const handleApprove = async () => {
        if (!requireAuth() || !discovery) return
        try {
            setConnecting(true)
            const token = await getAccessTokenSilently()
            await connectMcpConnector(token, {
                serverUrl: url.trim(),
                credentialRef: effectiveCredentialRef(),
                label: label.trim() || discovery.server_name,
                headers: MCP_AUTH_HEADERS,
                tools: discovery.tools,
            })
            showToast(t('settingsPage.connectorsSettings.connectedToast', { count: discovery.tools.length }))
            handleCloseFlow()
            await loadConnectors()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.connectorsSettings.connectErrorToast'))
        } finally {
            setConnecting(false)
        }
    }

    const handleDisconnect = async (connector: Connector) => {
        const confirmed = window.confirm(t('settingsPage.connectorsSettings.disconnectConfirm', {
            label: connector.label,
            count: connector.toolCount,
        }))
        if (!confirmed) return
        try {
            setBusyConnectorId(connector.id)
            const token = await getAccessTokenSilently()
            await disconnectConnector(token, connector.id)
            showToast(t('settingsPage.connectorsSettings.disconnectedToast'))
            await loadConnectors()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.connectorsSettings.disconnectErrorToast'))
        } finally {
            setBusyConnectorId(null)
        }
    }

    const selectionFull = selected.length >= MAX_IMPORTED_OPERATIONS

    const renderAddressFields = (
        urlHint: string,
        urlPlaceholder: string,
        urlHelp: string,
        secretHelp: string
    ) => (
        <>
            <InputTextWithHint
                hint={urlHint}
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder={urlPlaceholder}
            />
            {urlError
                ? <p className={styles.fieldError} data-testid="connector-url-error">{urlError}</p>
                : <p className={styles.fieldHelp}>{urlHelp}</p>}

            <label className={styles.credentialField}>
                <span className={styles.fieldLabel}>{t('settingsPage.connectorsSettings.keyHint')}</span>
                <input
                    className={styles.cellInput}
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={e => setSecret(e.target.value)}
                    placeholder={t('settingsPage.connectorsSettings.keyPlaceholder')}
                    data-testid="connector-key"
                />
            </label>
            <p className={styles.fieldHelp}>{secretHelp}</p>

            <InputTextWithHint
                hint={t('settingsPage.connectorsSettings.credentialNameHint')}
                value={credentialRef}
                onChange={e => setCredentialRef(e.target.value)}
                placeholder={suggestedCredentialRef(url.trim())
                    || t('settingsPage.connectorsSettings.credentialNamePlaceholder')}
            />
            <p className={styles.fieldHelp}>{t('settingsPage.connectorsSettings.credentialNameHelp')}</p>
        </>
    )

    return (
        <div className={styles.container}>
            <div className={styles.listSection}>
                <div className={styles.listHeader}>
                    <h3 className={styles.listTitle}>{t('settingsPage.connectorsSettings.yourConnectors')}</h3>
                    <PillButton
                        onClick={handleAddConnector}
                        label={t('settingsPage.connectorsSettings.addConnector')}
                        icon={ICONS.PLUS}
                        data-testid="add-connector"
                    />
                </div>

                {loadingList ? (
                    <p className={styles.emptyState}>{t('settingsPage.connectorsSettings.loading')}</p>
                ) : connectors.length === 0 ? (
                    <p className={styles.emptyState}>{t('settingsPage.connectorsSettings.noConnectorsYet')}</p>
                ) : (
                    <div className={styles.connectorList}>
                        {connectors.map(connector => (
                            <div
                                key={connector.id}
                                className={styles.connectorRow}
                                data-testid={`connector-row-${connector.id}`}
                            >
                                <div className={styles.connectorInfo}>
                                    <span className={styles.connectorLabel}>{connector.label}</span>
                                    <span className={styles.connectorRef}>{connector.ref}</span>
                                </div>
                                <div className={styles.connectorPills}>
                                    <span className={styles.pill}>
                                        {t(`settingsPage.connectorsSettings.kind_${connector.kind}`)}
                                    </span>
                                    <span className={styles.pill}>
                                        {t('settingsPage.connectorsSettings.toolCount', { count: connector.toolCount })}
                                    </span>
                                </div>
                                <div className={styles.connectorActions}>
                                    <PillButton
                                        onClick={() => handleDisconnect(connector)}
                                        label={busyConnectorId === connector.id
                                            ? t('settingsPage.connectorsSettings.disconnectingLabel')
                                            : t('settingsPage.connectorsSettings.disconnect')}
                                        variant="danger"
                                        disabled={busyConnectorId === connector.id}
                                        data-testid={`disconnect-connector-${connector.id}`}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {chooserOpen && (
                <div className={styles.form} data-testid="connector-chooser">
                    <h3 className={styles.formTitle}>{t('settingsPage.connectorsSettings.chooseTitle')}</h3>
                    <div className={styles.chooserOptions}>
                        <button
                            type="button"
                            className={styles.chooserOption}
                            onClick={() => handleChooseFlow('openapi')}
                            data-testid="choose-api-spec"
                        >
                            <span className={styles.chooserOptionTitle}>
                                {t('settingsPage.connectorsSettings.chooseSpec')}
                            </span>
                            <span className={styles.chooserOptionHelp}>
                                {t('settingsPage.connectorsSettings.chooseSpecHelp')}
                            </span>
                        </button>
                        <button
                            type="button"
                            className={styles.chooserOption}
                            onClick={() => handleChooseFlow('mcp')}
                            data-testid="choose-mcp-server"
                        >
                            <span className={styles.chooserOptionTitle}>
                                {t('settingsPage.connectorsSettings.chooseMcp')}
                            </span>
                            <span className={styles.chooserOptionHelp}>
                                {t('settingsPage.connectorsSettings.chooseMcpHelp')}
                            </span>
                        </button>
                    </div>
                    <div className={styles.formFooter}>
                        <PillButton
                            onClick={handleCloseFlow}
                            label={t('settingsPage.connectorsSettings.cancel')}
                            variant="secondary"
                            data-testid="cancel-connector-form"
                        />
                    </div>
                </div>
            )}

            {flow === 'openapi' && (
                <div className={styles.form} data-testid="spec-connector-form">
                    <h3 className={styles.formTitle}>{t('settingsPage.connectorsSettings.specTitle')}</h3>

                    <section className={styles.section}>
                        {renderAddressFields(
                            t('settingsPage.connectorsSettings.specUrlHint'),
                            t('settingsPage.connectorsSettings.specUrlPlaceholder'),
                            t('settingsPage.connectorsSettings.specUrlHelp'),
                            t('settingsPage.connectorsSettings.specKeyHelp')
                        )}
                        <div className={styles.sectionFooter}>
                            <PillButton
                                onClick={handlePreview}
                                label={previewing
                                    ? t('settingsPage.connectorsSettings.previewingLabel')
                                    : t('settingsPage.connectorsSettings.preview')}
                                icon={ICONS.SEND}
                                disabled={previewing || importing}
                                data-testid="preview-spec"
                            />
                        </div>
                    </section>

                    {previewError && (
                        <div className={styles.errorPanel} data-testid="preview-error">
                            <p className={styles.errorPanelTitle}>
                                {t('settingsPage.connectorsSettings.previewErrorTitle')}
                            </p>
                            <p className={styles.errorPanelDetail}>{previewError}</p>
                        </div>
                    )}

                    {preview && imported === null && (
                        <section className={`${styles.section} ${styles.approvalSection}`} data-testid="spec-preview">
                            <h4 className={styles.sectionTitle}>{preview.title}</h4>
                            <p className={styles.fieldHelp}>
                                {t('settingsPage.connectorsSettings.previewFound', {
                                    count: preview.operations.length,
                                    server: preview.server_url,
                                })}
                            </p>
                            <p className={styles.fieldHelp}>
                                {t('settingsPage.connectorsSettings.selectionHelp', { max: MAX_IMPORTED_OPERATIONS })}
                            </p>
                            <p className={styles.selectionCount} data-testid="selection-count">
                                {t('settingsPage.connectorsSettings.selectionCount', {
                                    selected: selected.length,
                                    max: MAX_IMPORTED_OPERATIONS,
                                })}
                            </p>
                            {selectionFull && (
                                <p className={styles.selectionFull} data-testid="selection-full">
                                    {t('settingsPage.connectorsSettings.selectionFull')}
                                </p>
                            )}

                            <div className={styles.operationList}>
                                {preview.operations.map(operation => (
                                    <label
                                        key={operation.name}
                                        className={styles.operationRow}
                                        data-testid={`operation-${operation.name}`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={selected.includes(operation.name)}
                                            disabled={selectionFull && !selected.includes(operation.name)}
                                            onChange={() => toggleOperation(operation.name)}
                                            data-testid={`operation-checkbox-${operation.name}`}
                                        />
                                        <span className={styles.operationMethod}>{operation.method}</span>
                                        <span className={styles.operationPath}>{operation.path}</span>
                                        <span className={styles.operationSummary}>{operation.description}</span>
                                        {operation.warnings && operation.warnings.length > 0 && (
                                            <span className={styles.operationWarning}>
                                                {t('settingsPage.connectorsSettings.operationWarnings', {
                                                    warnings: operation.warnings.join(' '),
                                                })}
                                            </span>
                                        )}
                                    </label>
                                ))}
                            </div>

                            {preview.skipped.length > 0 && (
                                <div className={styles.skippedBlock} data-testid="skipped-operations">
                                    <h5 className={styles.subsectionTitle}>
                                        {t('settingsPage.connectorsSettings.skippedTitle', {
                                            count: preview.skipped.length,
                                        })}
                                    </h5>
                                    {preview.skipped.map(skipped => (
                                        <p key={skipped.operationId} className={styles.skippedRow}>
                                            <span className={styles.skippedName}>{skipped.operationId}</span>
                                            <span className={styles.skippedReason}>{skipped.reason}</span>
                                        </p>
                                    ))}
                                </div>
                            )}

                            <div className={styles.sectionFooter}>
                                <PillButton
                                    onClick={handleImport}
                                    label={importing
                                        ? t('settingsPage.connectorsSettings.importingLabel')
                                        : t('settingsPage.connectorsSettings.import')}
                                    icon={ICONS.SAVE_ICON}
                                    disabled={importing || selected.length === 0}
                                    data-testid="import-spec"
                                />
                            </div>
                            <p className={styles.fieldHelp}>{t('settingsPage.connectorsSettings.importedHelp')}</p>
                        </section>
                    )}

                    {imported !== null && (
                        <section className={`${styles.section} ${styles.approvalSection}`} data-testid="spec-imported">
                            <h4 className={styles.sectionTitle}>
                                {t('settingsPage.connectorsSettings.importedTitle')}
                            </h4>
                            <p className={styles.fieldHelp}>
                                {t('settingsPage.connectorsSettings.importedToast', { count: imported })}
                            </p>
                            <p className={styles.fieldHelp}>{t('settingsPage.connectorsSettings.importedHelp')}</p>
                            <a className={styles.toolsLink} href={TOOLS_PATH} data-testid="open-tools">
                                {t('settingsPage.connectorsSettings.openTools')}
                            </a>
                        </section>
                    )}

                    <div className={styles.formFooter}>
                        <PillButton
                            onClick={handleCloseFlow}
                            label={imported !== null
                                ? t('settingsPage.connectorsSettings.done')
                                : t('settingsPage.connectorsSettings.cancel')}
                            variant="secondary"
                            disabled={previewing || importing}
                            data-testid="cancel-connector-form"
                        />
                    </div>
                </div>
            )}

            {flow === 'mcp' && (
                <div className={styles.form} data-testid="mcp-connector-form">
                    <h3 className={styles.formTitle}>{t('settingsPage.connectorsSettings.mcpTitle')}</h3>

                    <section className={styles.section}>
                        {renderAddressFields(
                            t('settingsPage.connectorsSettings.serverUrlHint'),
                            t('settingsPage.connectorsSettings.serverUrlPlaceholder'),
                            t('settingsPage.connectorsSettings.serverUrlHelp'),
                            t('settingsPage.connectorsSettings.mcpKeyHelp')
                        )}
                        <div className={styles.sectionFooter}>
                            <PillButton
                                onClick={handleDiscover}
                                label={discovering
                                    ? t('settingsPage.connectorsSettings.discoveringLabel')
                                    : t('settingsPage.connectorsSettings.discover')}
                                icon={ICONS.SEND}
                                disabled={discovering || connecting}
                                data-testid="discover-mcp"
                            />
                        </div>
                    </section>

                    {discoverError && (
                        <div className={styles.errorPanel} data-testid="discover-error">
                            <p className={styles.errorPanelTitle}>
                                {t('settingsPage.connectorsSettings.discoverErrorTitle')}
                            </p>
                            <p className={styles.errorPanelDetail}>{discoverError}</p>
                        </div>
                    )}

                    {discovery && (
                        <section className={`${styles.section} ${styles.approvalSection}`} data-testid="mcp-approval">
                            <h4 className={styles.sectionTitle}>
                                {t('settingsPage.connectorsSettings.approvalTitle')}
                            </h4>
                            <p className={styles.approvalLead}>
                                {t('settingsPage.connectorsSettings.approvalLead', {
                                    count: discovery.tools.length,
                                    server: discovery.server_name,
                                })}
                            </p>
                            <p className={styles.fieldHelp}>
                                {t('settingsPage.connectorsSettings.approvalNothingYet')}
                            </p>

                            <div className={styles.discoveredList}>
                                {discovery.tools.map(tool => (
                                    <div
                                        key={tool.name}
                                        className={styles.discoveredRow}
                                        data-testid={`discovered-tool-${tool.name}`}
                                    >
                                        <span className={styles.discoveredName}>{tool.name}</span>
                                        <span className={styles.discoveredDescription}>{tool.description}</span>
                                    </div>
                                ))}
                            </div>

                            <p className={styles.approvalPinned} data-testid="approval-pinned">
                                {t('settingsPage.connectorsSettings.approvalPinned')}
                            </p>

                            <InputTextWithHint
                                hint={t('settingsPage.connectorsSettings.approvalLabelHint')}
                                value={label}
                                onChange={e => setLabel(e.target.value)}
                                placeholder={discovery.server_name}
                            />
                            <p className={styles.fieldHelp}>
                                {t('settingsPage.connectorsSettings.approvalLabelHelp')}
                            </p>

                            <div className={styles.sectionFooter}>
                                <PillButton
                                    onClick={handleApprove}
                                    label={connecting
                                        ? t('settingsPage.connectorsSettings.approvingLabel')
                                        : t('settingsPage.connectorsSettings.approve', {
                                            count: discovery.tools.length,
                                        })}
                                    icon={ICONS.VALID}
                                    disabled={connecting || discovery.tools.length === 0}
                                    data-testid="approve-mcp"
                                />
                            </div>
                        </section>
                    )}

                    <div className={styles.formFooter}>
                        <PillButton
                            onClick={handleCloseFlow}
                            label={t('settingsPage.connectorsSettings.cancel')}
                            variant="secondary"
                            disabled={discovering || connecting}
                            data-testid="cancel-connector-form"
                        />
                    </div>
                </div>
            )}
        </div>
    )
}
