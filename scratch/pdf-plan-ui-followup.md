# PDF plan: UI follow-up after the component-library release

`pdf-plan-ui-followup.patch` wires the next `@genflowly/component-library`
release into genai-react-app and admin-panel. It is held back because both
apps install the library from GitHub Packages, and these changes use props and
types that only exist from that release on.

The library changes are on GenFlowly/component-library, branch
`claude/retrieval-server-runtime-tools-3rorik`:

- attach PDFs from the picker, paste or drag-and-drop (4.5)
- a "Writing PDF… N characters" line while a document is written (3.7)
- PDF branding settings on TOOL_EXECUTOR nodes in the graph editor (6.2)
- page count on the attachment card (6.4); the download tab opens inside the click (1.15)
- attachment URLs resolved within the conversation, for shared conversations (1.11)

What the patch does:

- genai-react-app: progress frames (`pg`) into the conversation, PDF uploads
  behind `REACT_APP_PDF_ATTACHMENTS` (turned on in `.env.development`), the
  graph editor's logo upload for a customer's own agents (`uploadAttachment(...,
  { keep: true })`: untagged, because the node row keeps it), and the
  `requiredHeaders` type now coming from the library.
- admin-panel: the graph editor's logo upload goes to
  `POST /admin/letterhead-logo` (System's attachments, untagged), and the
  standalone "PDF letterhead" panel is removed because the editor's own
  section replaces it.

## Applying it

1. Merge the library branch and let its release workflow publish the new version.
2. Bump `@genflowly/component-library` to that version in `genai-react-app`
   and `admin-panel` (`npm install @genflowly/component-library@<version>`).
3. From the repository root: `git apply scratch/pdf-plan-ui-followup.patch`.
4. Check: `CI=true npm test -- --watchAll=false` in genai-react-app (the five
   suites the patch touches held 45 passing tests against the library branch)
   and `npm run build` in admin-panel.
5. Set `REACT_APP_PDF_ATTACHMENTS=true` for production only once 4.4 (proxy
   PDF uploads) and 3.9 (customer purge) are live there.
6. Delete these two files in the same commit.
