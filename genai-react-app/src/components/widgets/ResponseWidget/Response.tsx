import React from 'react'
import styles from './Response.module.scss'
import { AIVendor } from '../../../constants/vendors'
import { useLayout } from '../../../context/LayoutContext'
import TextContainer from '../../common/TextContainer/TextContainer'

interface ResponseProps {
    responses: { vendor: AIVendor; text: string }[]
    onFollowUp?: () => void // ✅ new prop
}

export default function Response({ responses, onFollowUp }: ResponseProps) {
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    if (!responses || responses.length === 0) return null

    const sidebarsHidden = !isLeftSidebarExpanded && !isRightSidebarExpanded

    return (
        <div className={styles.container}>
            <div
                className={`${styles.inner} ${
                    sidebarsHidden ? styles.sideBySide : ''
                }`}
            >
                {responses.map(({ vendor, text }) => (
                    <div key={vendor} className={styles.responseWrapper}>
                        <TextContainer title={vendor} content={text} />

                        {onFollowUp && (
                            <div className={styles.followUpButtonWrapper}>
                                <button
                                    className={styles.followUpButton}
                                    onClick={onFollowUp}
                                >
                                    ➕ Follow up
                                </button>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}
