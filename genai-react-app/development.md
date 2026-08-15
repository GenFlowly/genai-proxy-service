# Development Guide

## Table of Contents

1. [Adding a New Page](#development-guide-adding-a-new-page)
2. [Gating Features with Entitlements](#gating-features-with-entitlements)
3. [Localization (i18n): No Hardcoded Strings](#localization-i18n-no-hardcoded-strings)

# Development Guide: Adding a New Page

This guide outlines the exact steps required to create a new page in the application, map it to a URL route, add it to the navigation bar, and ensure the UI layout (like the Navbar) displays correctly.

## 1. Map the Page to a URL Route

The React application uses `react-router-dom` for routing. All route mappings are centrally managed in `AppContent.tsx`.

1. Open `src/AppContent.tsx`.
2. Import your new page component at the top of the file.
3. Add a new `<Route />` inside the `<Routes>` block. If the page requires authentication, wrap it in `<ProtectedRoute>`.

```tsx
// src/AppContent.tsx
import NewFeaturePage from './pages/NewFeaturePage/NewFeaturePage';

<Routes>
    ...
    <Route path="/new-feature" element={<ProtectedRoute><NewFeaturePage /></ProtectedRoute>} />
</Routes>
```

## 2. Include the Navbar on Your New Page

Because this app **does not use a global layout wrapper**, every individual top-level page component is responsible for rendering the `<Navbar />`. If you forget this step, your page will load without navigation.

1. Open your page component (e.g., `src/pages/NewFeaturePage/NewFeaturePage.tsx`).
2. Import the `Navbar` component.
3. Wrap your page content in a root `div` that uses a `.page` CSS class.
4. Render `<Navbar />` as the first child of the root `div`.

```tsx
// src/pages/NewFeaturePage/NewFeaturePage.tsx
import React from 'react';
import Navbar from '../../components/navbar/Navbar';
import styles from './NewFeaturePage.module.scss';

export default function NewFeaturePage() {
    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.pageContainer}>
                <h1>New Feature</h1>
                {/* Your page content */}
            </div>
        </div>
    );
}
```

5. In your SCSS module (e.g., `src/pages/NewFeaturePage/NewFeaturePage.module.scss`), define the `.page` class to ensure it handles the 100vh height and flex layout properly, matching the rest of the application:

```scss
// src/pages/NewFeaturePage/NewFeaturePage.module.scss
.page {
    height: 100vh;
    overflow: hidden;
    background-color: var(--color-background-primary, #ffffff);
    display: flex;
    flex-direction: column;
}

.pageContainer {
    padding: 2rem;
    height: 100%;
    overflow-y: auto;
    width: 100%;
}
```

## 3. Add the Page to the Navbar Tabs

If you want your new page to be easily accessible from the top navigation tabs (like "Chat", "Memory", "Agents"), you need to add it to the Navbar Menu widget.

1. Open `src/components/widgets/NavbarMenuWidget/NavbarMenu.tsx`.
2. Locate the `NAV_ITEMS` array.
3. Add a new object for your page with a unique `id`, a display `label`, and the `path` that matches what you set in `AppContent.tsx`.

```tsx
// src/components/widgets/NavbarMenuWidget/NavbarMenu.tsx
export const NAV_ITEMS = [
    { id: 'chat', label: 'Chat', path: '/chat' },
    { id: 'memory', label: 'Memory', path: '/memory' },
    { id: 'agents', label: 'Agents', path: '/agents' },
    { id: 'instructions', label: 'Instructions', path: '/instructions' },
    { id: 'new-feature', label: 'New Feature', path: '/new-feature' }, // <-- Added here
];
```

The Navbar will automatically detect if the user is on that path (or a sub-path) and highlight the tab appropriately.

## 4. Add a New Page in the Settings Page

The application uses a dynamic **Widget Registry System** to render pages and sidebars inside the Settings page. You do not need to manually add new routes in `AppContent.tsx` for settings sub-pages.

1. **Create the Component (`src/components/widgets/`)**
   Create a new widget folder and component, for example: `ProfileSettingsWidget/ProfileSettingsWidget.tsx`.

2. **Register the Widget (`src/registry/WidgetRegistry.tsx`)**
   Add your new widget to the `WIDGET_REGISTRY`. You'll provide an ID (like `PROFILE_SETTINGS`), a display name, and lazy-load the React component.
   ```tsx
   PROFILE_SETTINGS: {
       id: 'PROFILE_SETTINGS',
       name: 'Profile Settings',
       component: lazy(() => import('../components/widgets/ProfileSettingsWidget/ProfileSettingsWidget'))
   },
   ```

3. **Add to the Settings Sidebar (`src/config/SidebarMenuConfig.ts`)**
   Find the `SIDEBAR_MENU_REGISTRY` array. Inside the object where `pageId: 'SETTINGS_PAGE'`, add your new widget to the `items` list so it appears in the sidebar menu:
   ```typescript
   items: [
       { widgetId: 'PROFILE_SETTINGS', label: 'Profile' },
       // ... existing items
   ]
   ```

4. **Add to the Center Section Config (`src/config/PageWidgetConfig.ts`)**
   In order for the Center Section to successfully switch to your widget when selected, it must be whitelisted in the page configuration. Locate the `SETTINGS_PAGE` object and append your new widget ID to the `centerSection` array:
   ```typescript
   centerSection: ['PROFILE_SETTINGS', 'CONFIGURE_AI_VENDOR_SETTINGS', 'DATABASE_CONNECTIONS_SETTINGS'],
   ```

5. **Set the Page Title (`src/hooks/usePageTitle.ts`)** *(Optional but recommended)*
   Update the title map so that the browser tab reflects the new settings page:
   ```typescript
   'PROFILE_SETTINGS': 'Profile Settings',
   ```

# Gating Features with Entitlements

Entitlements are the **single source of truth** for what the current customer is allowed to do in the UI (e.g., seeing the "Share" button). They live in `AuthContext` — do **not** gate features with ad-hoc auth checks (`isAuthenticated`, `customerId`, role checks scattered in components). Use the central `entitlements` object instead.

## Where They Live

- **Type definition:** `src/types/auth.types.ts` — the `Entitlements` interface.
- **Derivation:** `src/context/AuthContext.tsx` — the `entitlements` object is computed inside `AuthProvider` from strict auth state (`isAuthenticated` from Auth0 **and** a successful onboard, i.e. a non-null `customerId`).

```typescript
// src/types/auth.types.ts
export interface Entitlements {
    canShare: boolean;
}
```

```tsx
// src/context/AuthContext.tsx
const entitlements = {
    canShare: isStrictlyAuthenticated,
}
```

## Using an Entitlement in a Component

Read `entitlements` from `useAuth()` and gate the UI on the specific capability:

```tsx
import { useAuth } from '../../context/AuthContext';

export default function MyWidget() {
    const { entitlements } = useAuth();

    return (
        <div>
            {entitlements.canShare && (
                <PillButton label="Share" onClick={handleShareClick} />
            )}
        </div>
    );
}
```

Entitlements compose with entity-level permissions (e.g., a conversation's `role`). The entitlement answers "may this customer use this feature at all?"; the role answers "may they use it on this entity?". Check both:

```tsx
// ConversationHeader.tsx
const canShare = conversationRole === 'OWNER' || conversationRole === 'EDIT'
const showShare = entitlements.canShare && (isNewChat || canShare)
```

## Adding a New Entitlement

1. Add the flag to the `Entitlements` interface in `src/types/auth.types.ts`:
   ```typescript
   export interface Entitlements {
       canShare: boolean;
       canDoNewThing: boolean; // <-- new
   }
   ```
2. Derive it in `AuthProvider` (`src/context/AuthContext.tsx`) from auth state, onboarding data, or backend flags:
   ```tsx
   const entitlements = {
       canShare: isStrictlyAuthenticated,
       canDoNewThing: isStrictlyAuthenticated && someBackendFlag,
   }
   ```
3. Gate the UI with `useAuth().entitlements.canDoNewThing`.

## Testing

Components that read entitlements will crash in tests that stub `useAuth` without them. When mocking `AuthContext`, always include an `entitlements` object:

```tsx
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        entitlements: { canShare: true },
        // ...other fields your component reads
    }),
}));
```

To test the logged-out experience, set the relevant flags to `false` and assert the gated UI is absent:

```tsx
expect(screen.queryByTestId('conversation-share-button')).not.toBeInTheDocument();
```

## Important Caveat

Entitlements are **UI gating only** — they hide affordances from users who can't use them. They are not a security boundary. The backend must always enforce authorization on its endpoints (it does, via token auth); never rely on an entitlement check alone to protect an operation.

# Localization (i18n): No Hardcoded Strings

The app is localized with **react-i18next**. Every user-visible string lives in `src/i18n/locales/en/translation.json` and is looked up at render time with `t('...')`. **Never hardcode user-facing text in a component** — hardcoded strings show up in English for every user regardless of their language.

i18next is initialized in `src/i18n/index.ts` (imported once in `src/index.tsx`). It detects the browser language and falls back to English for missing keys.

## What Counts as a User-Visible String

Extract into `translation.json`:
- JSX text content, button labels, headings
- `placeholder=`, `title=` (tooltips), `aria-label=`, `alt=`
- Toast messages, `window.confirm` text, error messages that render in the UI (including thrown `Error` messages that a catch block displays via `err.message`)

Do **not** extract:
- Brand/product names ("OpenAI", "Claude", "Supabase", "Milvus Cloud")
- `console.*` output, thrown errors that are only logged, technical error codes
- localStorage/cache keys, routes/URLs, API field names, `data-testid` values
- Enum values coming from the server (translate at the display mapping if needed, not the data)
- Pure symbols/glyphs (`✓`, `▼`, `─────`)

## Adding a String to a New Component

1. Add the key to `src/i18n/locales/en/translation.json`. Keys are camelCase and nested `<namespace>.<componentName>.<key>`. Use the namespace of the feature area your component belongs to (`common`, `layout`, `conversation`, `notes`, `editor`, `sidebar`, `vendorSettings`, `dbSettings`, `profileWidget`, `instructionWidget`, `agentsPage`, `settingsPage`, `instructionsPage`, `instructionDetail`, `toasts`, `errors`), or add a new top-level namespace for a new feature:

   ```json
   {
     "settingsPage": {
       "newFeature": {
         "title": "New Feature",
         "saveButton": "Save"
       }
     }
   }
   ```

2. Use the `useTranslation` hook in the component:

   ```tsx
   import { useTranslation } from 'react-i18next';

   export default function NewFeature() {
       const { t } = useTranslation();
       return (
           <div>
               <h2>{t('settingsPage.newFeature.title')}</h2>
               <button>{t('settingsPage.newFeature.saveButton')}</button>
           </div>
       );
   }
   ```

If `t` is used inside a `useCallback`/`useMemo`/`useEffect`, add it to the dependency array.

## Dynamic Values: Interpolation, Never Concatenation

Word order differs across languages, so **never build a sentence by concatenating translated parts or template literals**. Put the variable inside the string with `{{...}}`:

```json
"noUsersFound": "No users found matching \"{{searchTerm}}\"."
```

```tsx
t('common.shareModal.noUsersFound', { searchTerm })
```

## Plurals

Don't hand-roll `${count} node${count === 1 ? '' : 's'}`. Use i18next plural keys — pass `count` and define `_one` / `_other` variants (add `_zero` if you want a distinct empty form):

```json
"meta_one": "{{count}} node · max {{maxIterations}} iterations",
"meta_other": "{{count}} nodes · max {{maxIterations}} iterations"
```

```tsx
t('agentsPage.agentCard.meta', { count: nodeCount, maxIterations })
```

Note: an interpolation variable named `count` always triggers plural resolution. If you just want to display a number without plural forms, name the variable something else (e.g. `{{tokenCount}}`).

## Sentences Containing Markup

For text with inline links or `<code>`, use the `<Trans>` component so translators get one full sentence and the markup stays in the component:

```tsx
import { Trans } from 'react-i18next';

<Trans i18nKey="settingsPage.developerSettings.subtitle">
    Send a key as <code>Authorization: Bearer gfy_...</code> — see
    the <a href={docsUrl}>API docs</a> for details.
</Trans>
```

## Strings Outside Components

Hooks only work in function components. In module-level code (helpers, config objects, services, context logic), import the i18n instance directly:

```ts
import i18n from '../i18n'; // adjust relative path

const message = i18n.t('errors.user.usernameTaken');
```

Caveat: `i18n.t` evaluated **at module load** (e.g. in a top-level constant) resolves once and won't react to runtime language switches. Prefer storing the *key* in the constant and translating at render/call time.

## Testing

`src/test/setupTests.ts` imports `src/i18n`, so components render real English strings in tests — assert on the visible English text as usual (`screen.getByText('Save')`). No per-test i18n mocking is needed.

## Adding a New Language

1. Create `src/i18n/locales/<lang>/translation.json` with the same key structure as the English file.
2. Register it in `src/i18n/index.ts`:

   ```ts
   import es from './locales/es/translation.json';
   // ...
   resources: { en: { translation: en }, es: { translation: es } },
   ```

Missing keys automatically fall back to English, so a partially translated language file is safe to ship.
