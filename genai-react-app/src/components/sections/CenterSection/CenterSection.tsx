import React from 'react'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import Response from '../../widgets/ResponseWidget/Response'
import { useConversation } from '../../../context/ConversationContext'
import styles from './CenterSection.module.scss'
import MultiPurposeButton from "../../common/MultiPurposeButton/MultiPurposeButton";

export default function CenterSection() {
    const { isLoading, generateResponses } = useConversation()

    return (
        <div className={styles.centerSection}>
            <div className={styles.contentWrapper}>
                <PromptEditor />
                <MultiPurposeButton
                    onClick={generateResponses}
                    label={isLoading ? 'Generating...' : 'Send to API'}
                    disabled={isLoading}
                />
                <Response />
            </div>
        </div>
    )
}
