/**
 * i18next bootstrap. The ConversationWidget (from @genflowly/component-library)
 * resolves its strings through the host's i18next instance — react-i18next is
 * a peer dependency of the library. The catalog is a copy of the library's
 * reference locales/en.json (the conversation.* and common.* namespaces the
 * widget uses).
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'

i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  resources: { en: { translation: en } },
})

export default i18n
