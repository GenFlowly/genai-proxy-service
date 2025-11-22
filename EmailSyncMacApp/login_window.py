from PyQt6.QtWidgets import (QMainWindow, QWidget, QVBoxLayout, QLabel, 
                             QPushButton, QApplication)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QFont, QColor, QPalette
from auth0_client import Auth0Client
from strings import get_strings

class LoginThread(QThread):
    """Thread to handle Auth0 login without blocking UI"""
    login_result = pyqtSignal(bool, str, object)  # success, message, user_info
    
    def __init__(self, auth_client):
        super().__init__()
        self.auth_client = auth_client
    
    def run(self):
        success, message = self.auth_client.login()
        user_info = self.auth_client.user_info if success else None
        self.login_result.emit(success, message, user_info)


class LoginWindow(QMainWindow):
    # Signal emitted when login is successful
    login_successful = pyqtSignal(object, object)  # auth_client, user_info
    
    def __init__(self):
        super().__init__()
        
        # Get localized strings
        self.strings = get_strings()
        
        self.setWindowTitle(f"{self.strings.get('app_title')} - Login")
        self.setFixedSize(500, 400)
        
        self.auth_client = Auth0Client()
        
        # Dark Mode Palette
        dark_palette = QPalette()
        dark_palette.setColor(QPalette.ColorRole.Window, QColor(53, 53, 53))
        dark_palette.setColor(QPalette.ColorRole.WindowText, Qt.GlobalColor.white)
        dark_palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
        dark_palette.setColor(QPalette.ColorRole.Button, QColor(53, 53, 53))
        dark_palette.setColor(QPalette.ColorRole.ButtonText, Qt.GlobalColor.white)
        QApplication.setPalette(dark_palette)
        
        # Main Widget
        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        layout = QVBoxLayout(main_widget)
        layout.setContentsMargins(50, 50, 50, 50)
        layout.setSpacing(30)
        layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
        
        # App Title
        title_label = QLabel(self.strings.get('app_title'))
        title_font = QFont()
        title_font.setBold(True)
        title_font.setPointSize(32)
        title_label.setFont(title_font)
        title_label.setStyleSheet("color: #FFFFFF;")
        title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(title_label)
        
        # Subtitle
        subtitle_label = QLabel(self.strings.get('app_subtitle'))
        subtitle_font = QFont()
        subtitle_font.setPointSize(14)
        subtitle_label.setFont(subtitle_font)
        subtitle_label.setStyleSheet("color: #AAAAAA;")
        subtitle_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(subtitle_label)
        
        layout.addSpacing(50)
        
        # Login Button
        self.login_btn = QPushButton(self.strings.get('login.login_button'))
        self.login_btn.setMinimumHeight(60)
        self.login_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.login_btn.setStyleSheet("""
            QPushButton {
                background-color: #4A90E2;
                color: white;
                border-radius: 8px;
                font-weight: bold;
                font-size: 18px;
                border: none;
            }
            QPushButton:hover {
                background-color: #357ABD;
            }
            QPushButton:pressed {
                background-color: #2A629A;
            }
            QPushButton:disabled {
                background-color: #555555;
                color: #AAAAAA;
            }
        """)
        self.login_btn.clicked.connect(self.start_login)
        layout.addWidget(self.login_btn)
        
        # Status Label
        self.status_label = QLabel(self.strings.get('login.please_login'))
        self.status_label.setStyleSheet("color: #AAAAAA; font-size: 13px;")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.status_label.setWordWrap(True)
        layout.addWidget(self.status_label)
        
        layout.addStretch()
    
    def start_login(self):
        """Start the login process"""
        self.login_btn.setEnabled(False)
        self.status_label.setText(self.strings.get('login.authenticating'))
        self.status_label.setStyleSheet("color: #4A90E2; font-size: 13px;")
        
        # Start login in background thread
        self.login_thread = LoginThread(self.auth_client)
        self.login_thread.login_result.connect(self.handle_login_result)
        self.login_thread.start()
    
    def handle_login_result(self, success, message, user_info):
        """Handle login result from thread"""
        self.login_btn.setEnabled(True)
        
        if success:
            self.status_label.setText(self.strings.get('login.welcome'))
            self.status_label.setStyleSheet("color: #50C878; font-size: 13px; font-weight: bold;")
            
            # Emit signal to show main window
            self.login_successful.emit(self.auth_client, user_info)
            
            # Close login window
            self.close()
        else:
            error_msg = self.strings.get('login.login_failed') + f": {message}"
            self.status_label.setText(error_msg)
            self.status_label.setStyleSheet("color: #FF5555; font-size: 13px; font-weight: bold;")
