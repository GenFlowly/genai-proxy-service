import sys
from PyQt6.QtWidgets import QApplication
from login_window import LoginWindow
from ui import MainWindow

class App:
    def __init__(self):
        self.app = QApplication(sys.argv)
        self.app.setStyle("Fusion")
        
        self.login_window = None
        self.main_window = None
        self.auth_client = None
        
    def show_login(self):
        """Show login window"""
        self.login_window = LoginWindow()
        self.login_window.login_successful.connect(self.on_login_successful)
        self.login_window.show()
    
    def on_login_successful(self, auth_client, user_info):
        """Handle successful login"""
        self.auth_client = auth_client
        
        # Show main window
        self.main_window = MainWindow(auth_client, user_info)
        self.main_window.logout_requested.connect(self.on_logout)
        self.main_window.show()
    
    def on_logout(self):
        """Handle logout"""
        if self.auth_client:
            self.auth_client.logout()
        
        # Close main window
        if self.main_window:
            self.main_window.close()
            self.main_window = None
        
        # Show login again
        self.show_login()
    
    def run(self):
        """Start the application"""
        self.show_login()
        return self.app.exec()

if __name__ == "__main__":
    app = App()
    sys.exit(app.run())
