import React from 'react'
import { MemoryKind } from '../../../models/memory.models'
import { kindLabel } from '../memoryLabels'
import styles from '../MemoryPage.module.scss'

interface KindToggleProps {
    value: MemoryKind
    onChange: (kind: MemoryKind) => void
    /** Id of the visible label naming the control. */
    labelledBy: string
}

/** Core or Episodic, as a two-part switch. */
export default function KindToggle({ value, onChange, labelledBy }: KindToggleProps): React.ReactElement {
    return (
        <div className={styles.segmented} role="group" aria-labelledby={labelledBy}>
            {(['CORE', 'EPISODIC'] as const).map(kind => (
                <button
                    key={kind}
                    type="button"
                    aria-pressed={value === kind}
                    className={`${styles.segment} ${value === kind ? styles.segmentOn : ''}`}
                    onClick={() => onChange(kind)}
                    data-testid={`memory-kind-${kind.toLowerCase()}`}
                >
                    {kindLabel(kind)}
                </button>
            ))}
        </div>
    )
}
