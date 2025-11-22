from setuptools import setup

APP = ['main.py']
DATA_FILES = ['assets']
OPTIONS = {
    'argv_emulation': True,
    'iconfile': 'assets/icon.png',
    'packages': ['PyQt6'],
    'includes': ['PyQt6.QtCore', 'PyQt6.QtGui', 'PyQt6.QtWidgets'],
    'plist': {
        'CFBundleName': 'EmailSync',
        'CFBundleDisplayName': 'EmailSync',
        'CFBundleGetInfoString': "EmailSync App",
        'CFBundleIdentifier': "com.antigravity.emailsync",
        'CFBundleVersion': "1.0.0",
        'CFBundleShortVersionString': "1.0.0",
        'NSHumanReadableCopyright': "Copyright © 2025 Antigravity, Inc. All Rights Reserved."
    }
}

setup(
    app=APP,
    data_files=DATA_FILES,
    options={'py2app': OPTIONS},
    setup_requires=['py2app'],
)
