import React, {useState} from 'react'
import '@mdxeditor/editor/style.css'
import {
    MDXEditor,
    toolbarPlugin,
    headingsPlugin,
    quotePlugin,
    markdownShortcutPlugin,
    listsPlugin,
    codeBlockPlugin,
    UndoRedo,
    BoldItalicUnderlineToggles,
    BlockTypeSelect,
    ListsToggle,
    InsertCodeBlock,
    thematicBreakPlugin,
    InsertImage,
    InsertTable,
    codeMirrorPlugin,
    InsertThematicBreak, CreateLink, linkDialogPlugin, imagePlugin, tablePlugin,
} from '@mdxeditor/editor'
import styles from './TextField.module.scss'

export default function TextField(): React.ReactElement {
    const [markdown, setMarkdown] = useState<string>(
        `# Write me code for hello world`
    )
    return (
        <div className={styles.container}>
            <label className={styles.label}>Prompt</label>

            <div className={styles.editorWrapper}>
                <MDXEditor
                    markdown={markdown}
                    onChange={setMarkdown}
                    className={styles.mdxEditorRoot}
                    contentEditableClassName={styles.editorContent}
                    plugins={[
                        toolbarPlugin({
                            toolbarContents: () => (
                                <>
                                    <UndoRedo/>
                                    <BoldItalicUnderlineToggles/>
                                    <InsertImage />
                                    <BlockTypeSelect/>
                                    <ListsToggle/>
                                    <InsertTable />
                                    <CreateLink />
                                    <InsertThematicBreak />
                                    <InsertCodeBlock/>
                                </>
                            ),
                        }),

                        headingsPlugin(),
                        imagePlugin(),
                        quotePlugin(),
                        markdownShortcutPlugin(),
                        listsPlugin(),
                        tablePlugin(),
                        linkDialogPlugin(),
                        thematicBreakPlugin(),
                        codeBlockPlugin({defaultCodeBlockLanguage: 'js'}),
                        codeMirrorPlugin({
                            codeBlockLanguages: {
                                js: 'JavaScript',
                                ts: 'TypeScript',
                                css: 'CSS',
                                java: 'Java',
                                kotlin: 'Kotlin',
                                python: 'Python'
                            }
                        }),
                    ]}
                />
            </div>
        </div>
    )
}