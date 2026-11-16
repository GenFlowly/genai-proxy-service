import React from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, Tooltip } from '@genflowly/component-library'
import { ICONS } from '../../../../constants/icons'
import { useLoadedInstruction } from '../../../../hooks/useLoadedInstruction'
import styles from './InstructionChip.module.scss'

/** The editor's instruction picker: the loaded instruction's icon and name. */
export default function InstructionChip({ onClick }: { onClick: () => void }): React.ReactElement {
    const { t } = useTranslation()
    const instruction = useLoadedInstruction()

    return (
        <Tooltip content={t('conversation.conversationHeader.chooseInstruction')} position="top">
            <button
                type="button"
                className={`${styles.chip} ${instruction ? '' : styles.empty}`}
                onClick={onClick}
                aria-label={t('conversation.conversationHeader.chooseInstruction')}
                data-testid="instruction-chip"
            >
                {instruction?.icon && <span aria-hidden="true">{instruction.icon}</span>}
                <span className={styles.name}>
                    {instruction?.name ?? t('conversation.conversationHeader.chooseInstruction')}
                </span>
                <Icon src={ICONS.ALT_ARROW_RIGHT} size={12} className={styles.chevron} />
            </button>
        </Tooltip>
    )
}
