# i18n Localization System

The EmailSync app now supports multiple languages through an i18n localization system.

## Supported Languages

- **English** (en) - Default
- **Spanish** (es)
- **Chinese** (zh)

## How It Works

The app automatically detects your Mac's locale and displays the UI in the appropriate language.

### Locale Detection

The `strings.py` module detects your system locale:
- Spanish Mac → Shows Spanish UI
- Chinese Mac → Shows Chinese UI  
- All others → Shows English UI

### File Structure

```
locales/
├── en.json    # English translations
├── es.json    # Spanish translations
└── zh.json    # Chinese translations
strings.py     # Localization manager
```

## Usage in Code

```python
from strings import get_strings

# Get strings instance
strings = get_strings()

# Get a simple string
title = strings.get('app_title')  # "EmailSync"

# Get nested strings (dot notation)
button_text = strings.get('login.login_button')  # "Login with Auth0"

# Strings with parameters
message = strings.get('sync.found_messages', count=7258, folder="Inbox")
# Result: "Found 7,258 messages in Inbox"
```

## Adding New Translations

1. **Add a new locale file**: Create `locales/fr.json` for French
2. **Update `strings.py`**: Add `'fr': 'fr'` to supported locales
3. **Translate all keys**: Copy `en.json` and translate all values

## Adding New Strings

When adding new UI text:

1. **Add to ALL locale files** (`en.json`, `es.json`, `zh.json`)
2. **Use dot notation** for organization:
   ```json
   {
     "section": {
       "subsection": {
         "key": "value"
       }
     }
   }
   ```
3. **Use parameters** for dynamic content:
   ```json
   {
     "message": "Synced {count} of {total} emails"
   }
   ```

## Testing Different Locales

To manually test a specific locale in your code:

```python
strings = get_strings()
strings.set_locale('es')  # Force Spanish
strings.set_locale('zh')  # Force Chinese
strings.set_locale('en')  # Force English
```

## Current Implementation Status

✅ **Fully Localized:**
- Login window
- (More UI components can be added)

⏳ **To Be Localized:**
- Main UI (ui.py) - Update remaining hardcoded strings
- IMAP client messages
- Error messages

## Benefits

- **Multi-language support** without code changes
- **Easy to add new languages**
- **Automatic locale detection**
- **Centralized string management**
- **No code duplication**
