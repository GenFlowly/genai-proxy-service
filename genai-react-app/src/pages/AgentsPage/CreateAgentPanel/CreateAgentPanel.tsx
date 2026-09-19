import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AIVendor } from '../../../constants/vendors'
import VendorModelSelect from '../../../components/common/VendorModelSelect/VendorModelSelect'
import { ScrollArea } from '@genflowly/component-library'
import styles from './CreateAgentPanel.module.scss'

const AVATAR_OPTIONS = ['🤖', '🦾', '🧠', '⚡', '🌟', '🔮', '🎯', '🚀']

const TOOLS = [
    { id: 'web_search', labelKey: 'agentsPage.createAgentPanel.tools.webSearch' },
    { id: 'code_executor', labelKey: 'agentsPage.createAgentPanel.tools.codeExecutor' },
    { id: 'email', labelKey: 'agentsPage.createAgentPanel.tools.email' },
    { id: 'database', labelKey: 'agentsPage.createAgentPanel.tools.database' },
    { id: 'file_reader', labelKey: 'agentsPage.createAgentPanel.tools.fileReader' },
    { id: 'calendar', labelKey: 'agentsPage.createAgentPanel.tools.calendar' },
]

const CONTEXT_WINDOWS = [
    { value: '1000', tokens: '1,000' },
    { value: '2000', tokens: '2,000' },
    { value: '4000', tokens: '4,000' },
    { value: '8000', tokens: '8,000' },
    { value: '16000', tokens: '16,000' },
    { value: '32000', tokens: '32,000' },
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

const MEMORY_LABEL_KEYS: Record<AgentFormData['memoryType'], string> = {
    'short-term': 'agentsPage.createAgentPanel.memoryTypes.shortTerm',
    'long-term': 'agentsPage.createAgentPanel.memoryTypes.longTerm',
    'none': 'agentsPage.createAgentPanel.memoryTypes.none',
}

export default function CreateAgentPanel({ onBack, onSave, onDeploy }: CreateAgentPanelProps) {
    const { t } = useTranslation()
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
                    {t('agentsPage.createAgentPanel.back')}
                </button>
                <h1 className={styles.title}>{t('agentsPage.createAgentPanel.title')}</h1>
                <div className={styles.headerActions}>
                    <button
                        className={styles.saveBtn}
                        onClick={() => onSave?.(form)}
                        type="button"
                    >
                        {t('agentsPage.createAgentPanel.save')}
                    </button>
                    <button
                        className={styles.deployBtn}
                        onClick={() => onDeploy?.(form)}
                        type="button"
                    >
                        {t('agentsPage.createAgentPanel.deploy')}
                    </button>
                </div>
            </div>

            <ScrollArea className={styles.body}>
                {/* Step 1 */}
                <section className={styles.step}>
                    <h2 className={styles.stepTitle}>
                        <span className={styles.stepNum}>1</span>
                        {t('agentsPage.createAgentPanel.stepBasics')}
                    </h2>
                    <div className={styles.card}>
                        <div className={styles.field}>
                            <label className={styles.label}>{t('agentsPage.createAgentPanel.agentName')}</label>
                            <input
                                className={styles.input}
                                type="text"
                                placeholder={t('agentsPage.createAgentPanel.agentNamePlaceholder')}
                                value={form.name}
                                onChange={e => update('name', e.target.value)}
                            />
                        </div>
                        <div className={styles.field}>
                            <label className={styles.label}>{t('agentsPage.createAgentPanel.description')}</label>
                            <input
                                className={styles.input}
                                type="text"
                                placeholder={t('agentsPage.createAgentPanel.descriptionPlaceholder')}
                                value={form.description}
                                onChange={e => update('description', e.target.value)}
                            />
                        </div>
                        <div className={styles.field}>
                            <label className={styles.label}>{t('agentsPage.createAgentPanel.avatar')}</label>
                            <div className={styles.avatarPicker}>
                                {AVATAR_OPTIONS.map(emoji => (
                                    <button
                                        key={emoji}
                                        className={`${styles.avatarOption} ${form.avatar === emoji ? styles.avatarSelected : ''}`}
                                        onClick={() => update('avatar', emoji)}
                                        type="button"
                                        aria-label={t('agentsPage.createAgentPanel.selectAvatarAriaLabel', { emoji })}
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
                        {t('agentsPage.createAgentPanel.stepModelPersonality')}
                    </h2>
                    <div className={styles.card}>
                        <div className={styles.field}>
                            <label className={styles.label}>{t('agentsPage.createAgentPanel.llmProviderModel')}</label>
                            <VendorModelSelect
                                vendor={form.aiVendor}
                                model={form.llmModel}
                                onChange={(v, m) => setForm(prev => ({ ...prev, aiVendor: v, llmModel: m }))}
                            />
                        </div>
                        <div className={styles.field}>
                            <div className={styles.labelRow}>
                                <label className={styles.label}>{t('agentsPage.createAgentPanel.temperature')}</label>
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
                                <span>{t('agentsPage.createAgentPanel.precise')}</span>
                                <span>{t('agentsPage.createAgentPanel.creative')}</span>
                            </div>
                        </div>
                        <div className={styles.field}>
                            <label className={styles.label}>{t('agentsPage.createAgentPanel.systemPrompt')}</label>
                            <textarea
                                className={styles.textarea}
                                placeholder={t('agentsPage.createAgentPanel.systemPromptPlaceholder')}
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
                        {t('agentsPage.createAgentPanel.stepToolsCapabilities')}
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
                                    <span className={styles.toolLabel}>{t(tool.labelKey)}</span>
                                </label>
                            ))}
                        </div>
                        <button className={styles.addToolBtn} type="button">
                            {t('agentsPage.createAgentPanel.addCustomTool')}
                        </button>
                    </div>
                </section>

                {/* Step 4 */}
                <section className={styles.step}>
                    <h2 className={styles.stepTitle}>
                        <span className={styles.stepNum}>4</span>
                        {t('agentsPage.createAgentPanel.stepMemory')}
                    </h2>
                    <div className={styles.card}>
                        <div className={styles.field}>
                            <label className={styles.label}>{t('agentsPage.createAgentPanel.memoryType')}</label>
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
                                        <span>{t(MEMORY_LABEL_KEYS[type])}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                        <div className={styles.field}>
                            <label className={styles.label}>{t('agentsPage.createAgentPanel.contextWindow')}</label>
                            <select
                                className={styles.select}
                                value={form.contextWindow}
                                onChange={e => update('contextWindow', e.target.value)}
                            >
                                {CONTEXT_WINDOWS.map(c => (
                                    <option key={c.value} value={c.value}>
                                        {t('agentsPage.createAgentPanel.contextWindowOption', { tokens: c.tokens })}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </section>
            </ScrollArea>
        </div>
    )
}
