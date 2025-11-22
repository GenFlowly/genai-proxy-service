import imaplib
import email
import time
from PyQt6.QtCore import QThread, pyqtSignal
from email_model import EmailModel
from api_client import ApiClient

class SyncThread(QThread):
    progress_update = pyqtSignal(int, int) # current, total
    sync_complete = pyqtSignal(str)
    error_occurred = pyqtSignal(str)
    log_message = pyqtSignal(str)
    sync_paused = pyqtSignal()
    sync_resumed = pyqtSignal()

    def __init__(self, server, port, user, password, folder, access_token=None):
        super().__init__()
        self.server = server
        self.port = port
        self.user = user
        self.password = password
        self.folder = folder
        self.access_token = access_token
        self.is_running = True
        self.is_paused = False
        self.api_client = ApiClient(access_token=access_token)

    def pause(self):
        """Pause the sync"""
        self.is_paused = True
        self.log_message.emit("⏸️ Sync paused")
        self.sync_paused.emit()

    def resume(self):
        """Resume the sync"""
        self.is_paused = False
        self.log_message.emit("▶️ Sync resumed")
        self.sync_resumed.emit()

    def stop(self):
        """Stop the sync completely"""
        self.is_running = False
        self.is_paused = False
        self.log_message.emit("⏹️ Sync stopped by user")

    def run(self):
        try:
            port_int = int(self.port)
            if port_int == 993:
                mail = imaplib.IMAP4_SSL(self.server, port_int)
            else:
                mail = imaplib.IMAP4(self.server, port_int)

            rv, data = mail.login(self.user, self.password)
            if rv != 'OK':
                self.error_occurred.emit("Login failed during sync")
                return

            # Select folder
            folder_name = self.folder
            if ' ' in folder_name and not folder_name.startswith('"'):
                folder_name = f'"{folder_name}"'
            
            rv, data = mail.select(folder_name, readonly=True)
            if rv != 'OK':
                self.error_occurred.emit(f"Could not select folder: {self.folder}")
                return

            # Search all messages
            rv, data = mail.search(None, "ALL")
            if rv != 'OK':
                self.error_occurred.emit("Search failed")
                return

            msg_ids = data[0].split()
            total = len(msg_ids)
            self.log_message.emit(f"Found {total} messages in {self.folder}")
            self.log_message.emit(f"Starting sync of all {total} emails...")

            # Sync ALL emails (no limit)
            ids_to_fetch = msg_ids
            
            self.log_message.emit("=" * 50)
            self.log_message.emit(f"📧 Beginning sync of {len(ids_to_fetch):,} emails...")
            self.log_message.emit("=" * 50)
            
            processed = 0
            for num in ids_to_fetch:
                # Check if stopped
                if not self.is_running:
                    self.log_message.emit("⚠️ Sync stopped by user")
                    break
                
                # Check if paused
                while self.is_paused and self.is_running:
                    time.sleep(0.1)  # Wait while paused
                
                # Check again after pause (user might have stopped during pause)
                if not self.is_running:
                    self.log_message.emit("⚠️ Sync stopped by user")
                    break
                
                rv, data = mail.fetch(num, '(RFC822)')
                if rv != 'OK':
                    continue

                raw_email = data[0][1]
                msg = email.message_from_bytes(raw_email)
                
                email_obj = EmailModel.from_message(msg, self.folder)
                
                # Send to API
                self.api_client.send_email_data(email_obj)

                processed += 1
                
                # Update progress
                self.progress_update.emit(processed, len(ids_to_fetch))
                
                # Log every 50 emails to show more frequent progress
                if processed % 50 == 0:
                    self.log_message.emit(f"✓ Synced {processed:,} / {len(ids_to_fetch):,} emails...")

            self.log_message.emit("=" * 50)
            mail.logout()
            
            if processed == len(ids_to_fetch):
                self.sync_complete.emit(f"✓ Synced {processed:,} messages from {self.folder}")
            else:
                self.sync_complete.emit(f"⚠️ Partial sync: {processed:,} / {len(ids_to_fetch):,} messages")

        except Exception as e:
            self.error_occurred.emit(f"Sync Error: {str(e)}")



class ConnectionThread(QThread):
    connection_result = pyqtSignal(bool, str)
    folders_result = pyqtSignal(list)

    def __init__(self, server, port, user, password):
        super().__init__()
        self.server = server
        self.port = port
        self.user = user
        self.password = password

    def run(self):
        try:
            port_int = int(self.port)
            if port_int == 993:
                mail = imaplib.IMAP4_SSL(self.server, port_int)
            else:
                mail = imaplib.IMAP4(self.server, port_int)

            rv, data = mail.login(self.user, self.password)
            
            if rv == 'OK':
                self.connection_result.emit(True, "Connected Successfully!")
                
                rv, mailboxes = mail.list()
                if rv == 'OK':
                    folders = [box.decode() for box in mailboxes]
                    self.folders_result.emit(folders)
                
                mail.logout()
            else:
                self.connection_result.emit(False, f"Login Failed: {data}")

        except Exception as e:
            self.connection_result.emit(False, f"Error: {str(e)}")
