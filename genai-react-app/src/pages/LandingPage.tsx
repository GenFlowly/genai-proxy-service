import React, { useState } from 'react'
import Navbar from '../components/Navbar'
import TextField from '../components/TextField'
import { generateText } from '../services/textGenService'
import { useAuth } from '../context/AuthContext'
import { AIVendor } from '../constants/vendors'
import ResponseViewer from '../components/ResponseViewer'
import LeftSidebar from '../components/LeftSidebar'
import RightSidebar from '../components/RightSidebar'
import { useAI, AIProvider } from '../context/AIContext'
import styles from './LandingPage.module.scss'

function LandingContent() {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { config } = useAI()
    const [markdown, setMarkdown] = useState('# Write me code for hello world')
    const [isLoading, setIsLoading] = useState(false)
    const [responses, setResponses] = useState<{ vendor: AIVendor; text: string }[]>([])

    const handleGenerateText = async () => {
        if (!isAuthenticated || !customerId) {
            alert('Please log in first.')
            return
        }

        const activeVendors = Object.entries(config.vendorSelections).filter(([_, m]) => m)
        if (activeVendors.length === 0) {
            alert('Please select at least one vendor and model.')
            return
        }

        setIsLoading(true)
        setResponses([])

        try {
            const token = await getAccessTokenSilently()
            const results: { vendor: AIVendor; text: string }[] = []

            for (const [vendor, model] of activeVendors) {
                const res = await generateText(token, {
                    vendor: vendor as AIVendor,
                    model,
                    prompt: markdown,
                    customerId,
                })
                results.push({ vendor: vendor as AIVendor, text: res.text ?? '' })
            }

            setResponses(results)
        } catch (error) {
            console.error('❌ Failed to generate text:', error)
            setResponses([{ vendor: AIVendor.OPENAI, text: 'Error generating text. Check console.' }])
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className={styles.layout}>
            <div className={styles.sidebarLeft}>
                <LeftSidebar />
            </div>

            <div className={styles.centerSection}>
                <div className={styles.contentWrapper}>
                    <TextField markdown={markdown} onMarkdownChange={setMarkdown} />
                    <button
                        onClick={handleGenerateText}
                        className={styles.submitButton}
                        disabled={isLoading}
                    >
                        {isLoading ? 'Generating...' : 'Send to API'}
                    </button>
                    <ResponseViewer responses={responses} />
                </div>
            </div>

            <div className={styles.sidebarRight}>
                <RightSidebar />
            </div>
        </div>
    )
}

export default function LandingPage() {
    return (
        <div className={styles.page}>
            <Navbar />
            <AIProvider>
                <LandingContent />
            </AIProvider>
        </div>
    )
}
