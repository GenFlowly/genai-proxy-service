import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../common/Icon/Icon'
import Tooltip from '../../common/Tooltip/Tooltip'
import stepsIcon from '../../../assets/icons/steps.svg'
import addExamplesIcon from '../../../assets/icons/add-examples.svg'
import copyIcon from '../../../assets/icons/copy-icon.svg'
import i18n from '../../../i18n'

// Component to handle copy state and visual feedback
const CopyButton = ({ view }: { view: any }) => {
    const { t } = useTranslation()
    const [copied, setCopied] = useState(false)

    const handleCopy = () => {
        if (!view) return
        const docString = view.state.doc.toString()
        navigator.clipboard.writeText(docString).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        })
    }

    return (
        <Tooltip content={copied ? t('editor.toolbar.copied') : t('editor.toolbar.copyToClipboard')}>
            <span
                onClick={handleCopy}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0 0.5rem', cursor: 'pointer' }}
            >
                {copied ? (
                    <span style={{ fontSize: '0.9rem', fontWeight: 500, color: '#4caf50' }}>✓</span>
                ) : (
                    <Icon src={copyIcon} size="1em" alt={t('editor.toolbar.copyAlt')} />
                )}
            </span>
        </Tooltip>
    )
}


export const addStepsCommand = {
    name: 'addSteps',
    keyCommand: 'addSteps',
    buttonProps: { 'aria-label': i18n.t('editor.toolbar.addStep') },
    icon: (
        // <Tooltip content="Add Steps">
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0 0.5rem' }}>
            <Icon src={stepsIcon} size="1em" alt={i18n.t('editor.toolbar.stepsAlt')} />
            <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>{i18n.t('editor.toolbar.addStep')}</span>
        </span>
        // </Tooltip>
    ),
    execute: (editor: any) => {
        const view = editor?.view
        if (!view) return

        const inputString = view.state.doc.toString()
        const regex = /Step (\d+):/g
        let maxStep = 0
        let match

        while ((match = regex.exec(inputString)) !== null) {
            const num = parseInt(match[1], 10)
            if (num > maxStep) {
                maxStep = num
            }
        }

        let modifyText = ''
        if (maxStep === 0) {
            modifyText = '\n\nFollow these steps -\nStep 1:\n'
        } else {
            modifyText = `\nStep ${maxStep + 1}:\n`
        }

        const { state } = view
        const { from, to } = state.selection.main

        view.dispatch({
            changes: { from, to, insert: modifyText }
        })
    },
}

export const addExamplesCommand = {
    name: 'addExamples',
    keyCommand: 'addExamples',
    buttonProps: { 'aria-label': i18n.t('editor.toolbar.addExample') },
    icon: (
        // <Tooltip content="Add Examples">
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0 0.5rem' }}>
            <Icon src={addExamplesIcon} size="1em" alt={i18n.t('editor.toolbar.examplesAlt')} />
            <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>{i18n.t('editor.toolbar.addExample')}</span>
        </span>
        // </Tooltip>
    ),
    execute: (editor: any) => {
        const view = editor?.view
        if (!view) return

        const inputString = view.state.doc.toString()
        const regex = /Example (\d+) -/g
        let maxExample = 0
        let match

        while ((match = regex.exec(inputString)) !== null) {
            const num = parseInt(match[1], 10)
            if (num > maxExample) {
                maxExample = num
            }
        }

        let modifyText = ''
        if (maxExample === 0) {
            modifyText = '\n\nExamples\n\nExample 1 - \nUser - \nResponse - \n'
        } else {
            modifyText = `\n\nExample ${maxExample + 1} - \nUser - \nResponse - \n`
        }

        const { state } = view
        const { from, to } = state.selection.main

        view.dispatch({
            changes: { from, to, insert: modifyText }
        })
    },
}

export const addCopyCommand = {
    name: 'copy',
    keyCommand: 'copy',
    buttonProps: { 'aria-label': i18n.t('editor.toolbar.copyToClipboardAria') },
    button: (command: any, props: any, options: any) => {


        return <CopyButton view={options.editor.current?.view} />
    },
    execute: (editor: any) => {
        // Execute handled by CopyButton onClick
    },
}
