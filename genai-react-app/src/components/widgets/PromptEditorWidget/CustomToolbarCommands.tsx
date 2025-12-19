import Tooltip from '../../common/Tooltip/Tooltip'
import stepsIcon from '../../../assets/icons/steps.svg'
import addExamplesIcon from '../../../assets/icons/add-examples.svg'

export const addStepsCommand = {
    name: 'addSteps',
    keyCommand: 'addSteps',
    buttonProps: { 'aria-label': 'Add Steps' },
    icon: (
        <Tooltip content="Add Steps">
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <img src={stepsIcon} style={{ width: '1em', height: '1em' }} alt="Steps" />
            </span>
        </Tooltip>
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
    buttonProps: { 'aria-label': 'Add Examples' },
    icon: (
        <Tooltip content="Add Examples">
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <img src={addExamplesIcon} style={{ width: '1em', height: '1em' }} alt="Examples" />
            </span>
        </Tooltip>
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
