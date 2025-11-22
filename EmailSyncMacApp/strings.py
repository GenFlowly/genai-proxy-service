import json
import os
import locale

class Strings:
    """
    Localization strings manager.
    Automatically detects system locale and loads appropriate translations.
    """
    
    def __init__(self):
        self.current_locale = self._detect_locale()
        self.strings = self._load_strings()
    
    def _detect_locale(self):
        """Detect system locale"""
        try:
            # Get system locale
            system_locale = locale.getdefaultlocale()[0]
            
            if system_locale:
                # Extract language code (first 2 characters)
                lang_code = system_locale[:2].lower()
                
                # Map to supported locales
                supported = {
                    'en': 'en',  # English
                    'es': 'es',  # Spanish
                    'zh': 'zh',  # Chinese
                }
                
                return supported.get(lang_code, 'en')
            
            return 'en'  # Default to English
        except:
            return 'en'
    
    def _load_strings(self):
        """Load translation strings for current locale"""
        try:
            locales_dir = os.path.join(os.path.dirname(__file__), 'locales')
            locale_file = os.path.join(locales_dir, f'{self.current_locale}.json')
            
            # Fallback to English if locale file not found
            if not os.path.exists(locale_file):
                locale_file = os.path.join(locales_dir, 'en.json')
            
            with open(locale_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading locale {self.current_locale}: {e}")
            # Return minimal English strings as fallback
            return {
                "app_title": "EmailSync",
                "app_subtitle": "Secure Email Synchronization"
            }
    
    def get(self, key_path, **kwargs):
        """
        Get localized string by dot-notation key path.
        
        Args:
            key_path: Dot-notation path like "connection.server_label"
            **kwargs: Format parameters for string interpolation
        
        Returns:
            Localized string with format parameters applied
        """
        keys = key_path.split('.')
        value = self.strings
        
        try:
            for key in keys:
                value = value[key]
            
            # Apply format parameters if provided
            if kwargs:
                return value.format(**kwargs)
            return value
        except (KeyError, TypeError):
            # Return key path if translation not found
            return key_path
    
    def set_locale(self, locale_code):
        """
        Manually set locale and reload strings.
        
        Args:
            locale_code: 'en', 'es', or 'zh'
        """
        if locale_code in ['en', 'es', 'zh']:
            self.current_locale = locale_code
            self.strings = self._load_strings()
            return True
        return False

# Global strings instance
_strings = Strings()

def get_strings():
    """Get the global strings instance"""
    return _strings
