# EmailSync

A production-ready macOS application for connecting to IMAP servers, built with Python and PyQt6.

## Features
- Connect to any IMAP server (SSL/TLS support).
- View IMAP folders.
- Secure password handling (masked input).
- Settings persistence (remembers server/user).
- Modern macOS UI with Dark Mode support.

## Development Setup

1. **Create Virtual Environment**:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```

2. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Run Locally**:
   ```bash
   python imap_app.py
   ```

## Building for macOS

To create a standalone `.app` bundle:

```bash
python setup.py py2app
```

The application will be in the `dist/` folder.

## App Store Submission (Important)

To submit this app to the Mac App Store, you must sign it with your Apple Developer Certificate.

1. **Enroll**: Ensure you have an Apple Developer account.
2. **Certificates**: Download your "Mac App Distribution" and "Mac Installer Distribution" certificates.
3. **Sign the App**:
   You need to sign the app bundle and all nested frameworks.
   ```bash
   codesign --deep --force --verbose --sign "3rd Party Mac Developer Application: Your Name (TEAMID)" dist/IMAP\ Connector.app
   ```
4. **Build Installer**:
   ```bash
   productbuild --component dist/IMAP\ Connector.app /Applications --sign "3rd Party Mac Developer Installer: Your Name (TEAMID)" IMAP_Connector.pkg
   ```
5. **Upload**: Use "Transporter" app or `xcrun altool` to upload the `.pkg` to App Store Connect.

## Troubleshooting
- If the app crashes on launch, check the Console app for logs.
- Ensure `py2app` is up to date.
