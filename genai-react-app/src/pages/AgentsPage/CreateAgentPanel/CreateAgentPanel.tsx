import React, { useState } from 'react'
import { AIVendor } from '../../../constants/vendors'
import VendorModelSelect from '../../../components/common/VendorModelSelect/VendorModelSelect'
import styles from './CreateAgentPanel.module.scss'

const AVATAR_OPTIONS = ['🤖', '🦾', '🧠', '⚡', '🌟', '🔮', '🎯', '🚀']

const TOOLS = [
    { id: 'web_search', label: 'Web Search' },
    { id: 'code_executor', label: 'Code Executor' },
    { id: 'email', label: 'Email' },
    { id: 'database', label: 'Database' },
    { id: 'file_reader', label: 'File Reader' },
    { id: 'calendar', label: 'Calendar' },
]

const CONTEXT_WINDOWS = [
    { value: '1000', label: '1,000 tokens' },
    { value: '2000', label: '2,000 tokens' },
    { value: '4000', label: '4,000 tokens' },
    { value: '8000', label: '8,000 tokens' },
    { value: '16000', label: '16,000 tokens' },
    { value: '32000', label: '32,000 tokens' },
]

export interface AgentFormData {
    name: string
    description: string
    avatar: string
    aiVendor: AIVendor | null
    llmModel: string
    temperature: number
    systemPrompt: string
    tools: string[]
    memoryType: 'short-term' | 'long-term' | 'none'
    contextWindow: string
}

interface CreateAgentPanelProps {
    onBack: () => void
    onSave?: (data: AgentFormData) => void
    onDeploy?: (data: AgentFormData) => void
}

const INITIAL_FORM: AgentFormData = {
    name: '',
    description: '',
    avatar: '🤖',
    aiVendor: null,
    llmModel: '',
    temperature: 0.7,
    systemPrompt: '',
    tools: ['web_search', 'code_executor', 'file_reader'],
    memoryType: 'short-term',
    contextWindow: '4000',
}

const MEMORY_LABELS: Record<AgentFormData['memoryType'], string> = {
    'short-term': 'Short-term',
    'long-term': 'Long-term',
    'none': 'None',
}

export default function CreateAgentPanel({ onBack, onSave, onDeploy }: CreateAgentPanelProps) {
    const [form, setForm] = useState<AgentFormData>(INITIAL_FORM)

    const update = <K extends keyof AgentFormData>(field: K, value: AgentFormData[K]) => {
        setForm(prev => ({ ...prev, [field]: value }))
    }

    const toggleTool = (toolId: string) => {
        setForm(prev => ({
            ...prev,
            tools: prev.tools.includes(toolId)
                ? prev.tools.filter(t => t !== toolId)
                : [...prev.tools, toolId],
        }))
    }

    return (
        <div className={styles.panel}>
            <div className={styles.header}>
                <button className={styles.backBtn} onClick={onBack} type="button">
                    ← Back
                </button>
                <h1 className={styles.title}>CREATE NEW AGENT</h1>
                <div className={styles.headerActions}>
                    <button
                        className={styles.saveBtn}
                        onClick={() => onSave?.(form)}
                        type="button"
                    >
                        Save
                    </button>
                    <button
                        className={styles.deployBtn}
                        onClick={() => onDeploy?.(form)}
                        type="button"
                    >
                        Deploy
                    </button>
                </div>
            </div>

            <div className={styles.body}>
                {/* Step 1 */}
                <section className={styles.step}>
                    <h2 className={styles.stepTitle}>
                        <span className={styles.stepNum}>1</span>
                        BASICS
                    </h2>
                    <div className={styles.card}>
                        <div className={styles.field}>
                            <label className={styles.label}>Agent Name</label>
                            <input
                                className={styles.input}
                                type="text"
                                placeholder="e.g. Research Assistant"
                                value={form.name}
                                onChange={e => update('name', e.target.value)}
                            />
                        </div>
                        <div className={styles.field}>
                            <label className={styles.label}>Description</label>
                            <input
                                className={styles.input}
                                type="text"
                                placeholder="What does this agent do?"
                                value={form.description}
                                onChange={e => update('description', e.target.value)}
                            />
                        </div>
                        <div className={styles.field}>
                            <label className={styles.label}>Avatar</label>
                            <div className={styles.avatarPicker}>
                                {AVATAR_OPTIONS.map(emoji => (
                                    <button
                                        key={emoji}
                                        className={`${styles.avatarOption} ${form.avatar === emoji ? styles.avatarSelected : ''}`}
                                        onClick={() => update('avatar', emoji)}
                                        type="button"
                                        aria-label={`Select avatar ${emoji}`}
                                    >
                                        {emoji}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>

                {/* Step 2 */}
                <section className={styles.step}>
                    <h2 className={styles.stepTitle}>
                        <span className={styles.stepNum}>2</span>
                        MODEL & PERSONALITY
                    </h2>
                    <div className={styles.card}>
                        <div className={styles.field}>
                            <label className={styles.label}>LLM Provider & Model</label>
                            <VendorModelSelect
                                vendor={form.aiVendor}
                                model={form.llmModel}
                                onChange={(v, m) => setForm(prev => ({ ...prev, aiVendor: v, llmModel: m }))}
                            />
                        </div>
                        <div className={styles.field}>
                            <div className={styles.labelRow}>
                                <label className={styles.label}>Temperature</label>
                                <span className={styles.temperatureValue}>{form.temperature.toFixed(1)}</span>
                            </div>
                            <input
                                className={styles.slider}
                                type="range"
                                min="0"
                                max="1"
                                step="0.1"
                                value={form.temperature}
                                onChange={e => update('temperature', parseFloat(e.target.value))}
                            />
                            <div className={styles.sliderLabels}>
                                <span>Precise</span>
                                <span>Creative</span>
                            </div>
                        </div>
                        <div className={styles.field}>
                            <label className={styles.label}>System Prompt</label>
                            <textarea
                                className={styles.textarea}
                                placeholder="You are a helpful assistant that..."
                                value={form.systemPrompt}
                                onChange={e => update('systemPrompt', e.target.value)}
                                rows={5}
                            />
                        </div>
                    </div>
                </section>

                {/* Step 3 */}
                <section className={styles.step}>
                    <h2 className={styles.stepTitle}>
                        <span className={styles.stepNum}>3</span>
                        TOOLS & CAPABILITIES
                    </h2>
                    <div className={styles.card}>
                        <div className={styles.toolsGrid}>
                            {TOOLS.map(tool => (
                                <label key={tool.id} className={styles.toolItem}>
                                    <input
                                        type="checkbox"
                                        className={styles.checkbox}
                                        checked={form.tools.includes(tool.id)}
                                        onChange={() => toggleTool(tool.id)}
                                    />
                                    <span className={styles.toolLabel}>{tool.label}</span>
                                </label>
                            ))}
                        </div>
                        <button className={styles.addToolBtn} type="button">
                            + Add Custom Tool
                        </button>
                    </div>
                </section>

                {/* Step 4 */}
                <section className={styles.step}>
                    <h2 className={styles.stepTitle}>
                        <span className={styles.stepNum}>4</span>
                        MEMORY
                    </h2>
                    <div className={styles.card}>
                        <div className={styles.field}>
                            <label className={styles.label}>Memory Type</label>
                            <div className={styles.radioGroup}>
                                {(['short-term', 'long-term', 'none'] as const).map(type => (
                                    <label key={type} className={styles.radioItem}>
                                        <input
                                            type="radio"
                                            name="memoryType"
                                            value={type}
                                            checked={form.memoryType === type}
                                            onChange={() => update('memoryType', type)}
                                        />
                                        <span>{MEMORY_LABELS[type]}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                        <div className={styles.field}>
                            <label className={styles.label}>Context Window</label>
                            <select
                                className={styles.select}
                                value={form.contextWindow}
                                onChange={e => update('contextWindow', e.target.value)}
                            >
                                {CONTEXT_WINDOWS.map(c => (
                                    <option key={c.value} value={c.value}>{c.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    )
}
