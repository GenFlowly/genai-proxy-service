import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { Modal, InputTextWithHint, InstructionTile, ScrollArea } from '@genflowly/component-library'
import { searchInstructions, getRecentInstructions } from '../../../services/instructionService'
import { InstructionResponse } from '../../../models/instruction.models'
import { loadRecentInstructionsCache, saveRecentInstructionsCache } from './recentInstructionsCache'
import styles from './InstructionPickerModal.module.scss'

const SEARCH_DEBOUNCE_MS = 300
const RECENT_LIMIT = 3

interface InstructionPickerModalProps {
    isOpen: boolean
    onClose: () => void
    onSelect: (instruction: InstructionResponse) => void
}

export default function InstructionPickerModal({
    isOpen,
    onClose,
    onSelect,
}: InstructionPickerModalProps) {
    const { t } = useTranslation()
    const { getAccessTokenSilently, customerId } = useAuth()

    const [query, setQuery] = useState('')
    const [recent, setRecent] = useState<InstructionResponse[]>([])
    const [results, setResults] = useState<InstructionResponse[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [hasError, setHasError] = useState(false)

    const isSearching = query.trim().length > 0

    // Load the recently used instructions whenever the picker opens:
    // stale-while-revalidate — paint the last known list immediately (if
    // any), then refresh from the API in the background
    useEffect(() => {
        if (!isOpen) return
        setQuery('')
        setResults([])
        setHasError(false)
        const cached = loadRecentInstructionsCache(customerId)
        if (cached) setRecent(cached)
        let cancelled = false
        void (async () => {
            setIsLoading(true)
            try {
                const token = await getAccessTokenSilently()
                const response = await getRecentInstructions(token, RECENT_LIMIT)
                if (!cancelled) {
                    setRecent(response.instructions)
                    saveRecentInstructionsCache(customerId, response.instructions)
                }
            } catch (error) {
                console.error('Failed to load recent instructions', error)
                // Keep showing the stale list; only surface the error when
                // there is nothing to show instead
                if (!cancelled && !cached) setHasError(true)
            } finally {
                if (!cancelled) setIsLoading(false)
            }
        })()
        return () => { cancelled = true }
        // getAccessTokenSilently is intentionally omitted: it is not
        // referentially stable and would re-trigger the fetch on renders
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, customerId])

    // Debounced server-side search
    useEffect(() => {
        if (!isOpen || !isSearching) return
        let cancelled = false
        const timer = setTimeout(() => {
            void (async () => {
                setIsLoading(true)
                setHasError(false)
                try {
                    const token = await getAccessTokenSilently()
                    const response = await searchInstructions(token, query.trim())
                    if (!cancelled) setResults(response.instructions)
                } catch (error) {
                    console.error('Failed to search instructions', error)
                    if (!cancelled) setHasError(true)
                } finally {
                    if (!cancelled) setIsLoading(false)
                }
            })()
        }, SEARCH_DEBOUNCE_MS)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, isSearching, query])

    if (!isOpen) return null

    const shown = isSearching ? results : recent
    const listTitle = isSearching
        ? t('conversation.instructionPicker.searchResults')
        : t('conversation.instructionPicker.recentlyUsed')

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t('conversation.instructionPicker.title')}
            maxWidth="48rem"
        >
            <div className={styles.picker}>
                <InputTextWithHint
                    placeholder={t('conversation.instructionPicker.searchPlaceholder')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                    data-testid="instruction-picker-search"
                />

                <h4 className={styles.listTitle}>{listTitle}</h4>

                {hasError ? (
                    <p className={styles.stateText}>{t('conversation.instructionPicker.error')}</p>
                ) : isLoading && shown.length === 0 ? (
                    <p className={styles.stateText}>{t('conversation.instructionPicker.loading')}</p>
                ) : shown.length === 0 ? (
                    <p className={styles.stateText}>
                        {isSearching
                            ? t('conversation.instructionPicker.noResults')
                            : t('conversation.instructionPicker.noRecent')}
                    </p>
                ) : (
                    <ScrollArea className={styles.tiles}>
                        <div className={styles.tilesGrid}>
                            {shown.map(instruction => (
                                <InstructionTile
                                    key={instruction.id}
                                    title={instruction.name || t('common.instructionTile.untitledInstruction')}
                                    detail={instruction.instruction}
                                    icon={instruction.icon || undefined}
                                    color={instruction.color || undefined}
                                    tags={instruction.tags || undefined}
                                    version={instruction.version}
                                    onClick={() => onSelect(instruction)}
                                    data-testid={`instruction-picker-tile-${instruction.id}`}
                                />
                            ))}
                        </div>
                    </ScrollArea>
                )}
            </div>
        </Modal>
    )
}
