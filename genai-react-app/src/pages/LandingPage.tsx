import React, { useState } from 'react'
import Navbar from '../components/Navbar'
import TextField from '../components/TextField'
import { generateText } from '../services/textGenService'
import { useAuth } from '../context/AuthContext'
import { AIVendor } from '../constants/vendors'
import styles from './LandingPage.module.scss'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'

export default function LandingPage(): React.ReactElement {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const [markdown, setMarkdown] = useState<string>('# Write me code for hello world')
    const [isLoading, setIsLoading] = useState(false)
    const [responses, setResponses] = useState<{ vendor: AIVendor; text: string }[]>([])
    const [selectedVendors, setSelectedVendors] = useState<AIVendor[]>([])

    const allVendors = Object.values(AIVendor) as AIVendor[]

    const toggleVendor = (vendor: AIVendor) => {
        setSelectedVendors(prev =>
            prev.includes(vendor) ? prev.filter(v => v !== vendor) : [...prev, vendor]
        )
    }

    const handleGenerateText = async () => {
        if (!isAuthenticated || !customerId) {
            alert('Please log in first.')
            return
        }

        if (selectedVendors.length === 0) {
            alert('Please select at least one vendor.')
            return
        }

        setIsLoading(true)
        setResponses([])

        try {
            const token = await getAccessTokenSilently()

            const results: { vendor: AIVendor; text: string }[] = []

            for (const vendor of selectedVendors) {
                const res = await generateText(token, {
                    vendor,
                    model: 'gpt-oss-120b',
                    prompt: markdown,
                    customerId,
                })
                results.push({ vendor, text: res.text ?? '' })
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
        <div className={styles.page}>
            <Navbar />
            <div className={styles.content}>
                <TextField markdown={markdown} onMarkdownChange={setMarkdown} />

                {/* Vendor Selection */}
                <div className={styles.vendorSection}>
                    <label>Select Vendors:</label>
                    <div className={styles.vendorList}>
                        {allVendors.map(vendor => (
                            <button
                                key={vendor}
                                type="button"
                                className={`${styles.vendorButton} ${
                                    selectedVendors.includes(vendor) ? styles.selected : ''
                                }`}
                                onClick={() => toggleVendor(vendor)}
                            >
                                {vendor}
                            </button>
                        ))}
                    </div>

                    {selectedVendors.length > 0 && (
                        <div className={styles.selectedVendors}>
                            {selectedVendors.map(v => (
                                <span key={v} className={styles.vendorTag}>
                  {v}
                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* Submit */}
                <button
                    onClick={handleGenerateText}
                    className={styles.submitButton}
                    disabled={isLoading}
                >
                    {isLoading ? 'Generating...' : 'Send to API'}
                </button>

                {/* Response Section */}
                {responses.length > 0 && (
                    <div className={styles.responseBox}>

                        {responses.map(({ vendor, text }) => (
                            <div key={vendor} className={styles.responseContent}>

                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    rehypePlugins={[rehypeHighlight]}
                                >
                                    {text}
                                </ReactMarkdown>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
