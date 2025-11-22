import os
from PyQt6.QtWidgets import (QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, 
                            QLabel, QLineEdit, QPushButton, QTextEdit,
                            QFrame, QTreeWidget, QTreeWidgetItem, QProgressBar, 
                            QApplication, QSplitter, QGridLayout)
from PyQt6.QtCore import Qt, QSettings, QSize, pyqtSignal
from PyQt6.QtGui import QIcon, QFont, QColor, QPalette
from imap_client import ConnectionThread, SyncThread

class MainWindow(QMainWindow):
    # Signal for logout
    logout_requested = pyqtSignal()
    
    def __init__(self, auth_client=None, user_info=None):
        super().__init__()
        self.setWindowTitle("EmailSync")
        self.setMinimumSize(1000, 700)
        
        self.auth_client = auth_client
        self.user_info = user_info
        
        # Set Icon
        icon_path = os.path.join(os.path.dirname(__file__), 'assets', 'icon.png')
        if os.path.exists(icon_path):
            self.setWindowIcon(QIcon(icon_path))

        # Settings
        self.settings = QSettings("Antigravity", "EmailSync")

        # Dark Mode Palette
        dark_palette = QPalette()
        dark_palette.setColor(QPalette.ColorRole.Window, QColor(53, 53, 53))
        dark_palette.setColor(QPalette.ColorRole.WindowText, Qt.GlobalColor.white)
        dark_palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
        dark_palette.setColor(QPalette.ColorRole.AlternateBase, QColor(53, 53, 53))
        dark_palette.setColor(QPalette.ColorRole.ToolTipBase, Qt.GlobalColor.white)
        dark_palette.setColor(QPalette.ColorRole.ToolTipText, Qt.GlobalColor.white)
        dark_palette.setColor(QPalette.ColorRole.Text, Qt.GlobalColor.white)
        dark_palette.setColor(QPalette.ColorRole.Button, QColor(53, 53, 53))
        dark_palette.setColor(QPalette.ColorRole.ButtonText, Qt.GlobalColor.white)
        dark_palette.setColor(QPalette.ColorRole.BrightText, Qt.GlobalColor.red)
        dark_palette.setColor(QPalette.ColorRole.Link, QColor(42, 130, 218))
        dark_palette.setColor(QPalette.ColorRole.Highlight, QColor(42, 130, 218))
        dark_palette.setColor(QPalette.ColorRole.HighlightedText, Qt.GlobalColor.black)
        QApplication.setPalette(dark_palette)

        # Main Widget
        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        main_layout = QHBoxLayout(main_widget)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        # Splitter for resizable panels
        splitter = QSplitter(Qt.Orientation.Horizontal)
        
        # LEFT PANEL - Connection Form
        left_panel = QWidget()
        left_panel.setMinimumWidth(400)
        left_panel.setMaximumWidth(600)
        left_layout = QVBoxLayout(left_panel)
        left_layout.setContentsMargins(30, 30, 30, 30)
        left_layout.setSpacing(20)

        # User Profile Header (if authenticated)
        if self.user_info:
            profile_layout = QHBoxLayout()
            
            user_name = self.user_info.get('name', self.user_info.get('email', 'User'))
            profile_label = QLabel(f"👤 {user_name}")
            profile_label.setStyleSheet("color: #AAAAAA; font-size: 13px;")
            profile_layout.addWidget(profile_label)
            profile_layout.addStretch()
            
            logout_btn = QPushButton("Logout")
            logout_btn.setCursor(Qt.CursorShape.PointingHandCursor)
            logout_btn.setStyleSheet("""
                QPushButton {
                    background-color: transparent;
                    color: #FF5555;
                    border: 1px solid #FF5555;
                    border-radius: 4px;
                    padding: 4px 10px;
                    font-size: 11px;
                    font-weight: bold;
                }
                QPushButton:hover {
                    background-color: #FF5555;
                    color: white;
                }
            """)
            logout_btn.clicked.connect(self.logout_requested.emit)
            profile_layout.addWidget(logout_btn)
            
            left_layout.addLayout(profile_layout)

        # Title
        title_label = QLabel("EmailSync")
        title_font = QFont()
        title_font.setBold(True)
        title_font.setPointSize(24)
        title_label.setFont(title_font)
        title_label.setStyleSheet("color: #FFFFFF;")
        left_layout.addWidget(title_label)

        # Form Grid Layout for perfect alignment
        form_grid = QGridLayout()
        form_grid.setVerticalSpacing(15)
        form_grid.setHorizontalSpacing(15)
        form_grid.setColumnStretch(1, 1)  # Input column stretches

        # Input Style
        input_style = """
            QLineEdit {
                padding: 10px 12px;
                background-color: #1E1E1E; 
                border: 2px solid #888888; 
                border-radius: 6px;
                color: #FFFFFF;
                font-size: 14px;
                selection-background-color: #2196F3;
                selection-color: #FFFFFF;
            }
            QLineEdit:focus {
                border: 2px solid #64B5F6;
                background-color: #252525;
            }
            QLineEdit::placeholder {
                color: #888888;
            }
        """
        
        # Label Style
        label_style = """
            QLabel {
                color: #CCCCCC;
                font-size: 14px;
                font-weight: bold;
            }
        """
        
        # Server Address Field
        server_label = QLabel("Server:")
        server_label.setStyleSheet(label_style)
        server_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.server_input = QLineEdit()
        self.server_input.setMinimumHeight(40)
        self.server_input.setPlaceholderText("e.g., imap.gmail.com")
        self.server_input.setText(self.settings.value("server", ""))
        self.server_input.setStyleSheet(input_style)
        self.server_input.setAccessibleName("Server Address")
        form_grid.addWidget(server_label, 0, 0)
        form_grid.addWidget(self.server_input, 0, 1)

        # Port Field
        port_label = QLabel("Port:")
        port_label.setStyleSheet(label_style)
        port_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.port_input = QLineEdit()
        self.port_input.setMinimumHeight(40)
        self.port_input.setMaximumWidth(150)
        self.port_input.setText(self.settings.value("port", "993"))
        self.port_input.setStyleSheet(input_style)
        self.port_input.setAccessibleName("Port")
        form_grid.addWidget(port_label, 1, 0)
        form_grid.addWidget(self.port_input, 1, 1, 1, 1, Qt.AlignmentFlag.AlignLeft)

        # Username Field
        username_label = QLabel("Username:")
        username_label.setStyleSheet(label_style)
        username_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.user_input = QLineEdit()
        self.user_input.setMinimumHeight(40)
        self.user_input.setPlaceholderText("email@example.com")
        self.user_input.setText(self.settings.value("user", ""))
        self.user_input.setStyleSheet(input_style)
        self.user_input.setAccessibleName("Username")
        form_grid.addWidget(username_label, 2, 0)
        form_grid.addWidget(self.user_input, 2, 1)

        # Password Field
        password_label = QLabel("Password:")
        password_label.setStyleSheet(label_style)
        password_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.pass_input = QLineEdit()
        self.pass_input.setMinimumHeight(40)
        self.pass_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.pass_input.setPlaceholderText("Enter your password")
        self.pass_input.setStyleSheet(input_style)
        self.pass_input.setAccessibleName("Password")
        form_grid.addWidget(password_label, 3, 0)
        form_grid.addWidget(self.pass_input, 3, 1)

        left_layout.addLayout(form_grid)

        # Connect Button
        self.connect_btn = QPushButton("Connect to Server")
        self.connect_btn.setMinimumHeight(50)
        self.connect_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.connect_btn.setStyleSheet("""
            QPushButton {
                background-color: #4A90E2;
                color: white;
                border-radius: 8px;
                font-weight: bold;
                font-size: 16px;
                border: none;
                margin-top: 10px;
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
        self.connect_btn.clicked.connect(self.start_connection)
        left_layout.addWidget(self.connect_btn)

        # Progress Bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        self.progress_bar.setStyleSheet("""
            QProgressBar {
                border: 1px solid #555555;
                border-radius: 4px;
                text-align: center;
                color: white;
                max-height: 20px;
            }
            QProgressBar::chunk {
                background-color: #4A90E2;
            }
        """)
        left_layout.addWidget(self.progress_bar)

        # Sync Control Buttons (initially hidden)
        control_buttons_layout = QHBoxLayout()
        control_buttons_layout.setSpacing(10)
        
        self.pause_btn = QPushButton("⏸️ Pause")
        self.pause_btn.setVisible(False)
        self.pause_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.pause_btn.setStyleSheet("""
            QPushButton {
                background-color: #FFA500;
                color: white;
                border-radius: 4px;
                padding: 8px 15px;
                font-size: 13px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #FF8C00;
            }
        """)
        self.pause_btn.clicked.connect(self.pause_sync)
        control_buttons_layout.addWidget(self.pause_btn)
        
        self.resume_btn = QPushButton("▶️ Resume")
        self.resume_btn.setVisible(False)
        self.resume_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.resume_btn.setStyleSheet("""
            QPushButton {
                background-color: #50C878;
                color: white;
                border-radius: 4px;
                padding: 8px 15px;
                font-size: 13px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #45B369;
            }
        """)
        self.resume_btn.clicked.connect(self.resume_sync)
        control_buttons_layout.addWidget(self.resume_btn)
        
        self.stop_btn = QPushButton("⏹️ Stop")
        self.stop_btn.setVisible(False)
        self.stop_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.stop_btn.setStyleSheet("""
            QPushButton {
                background-color: #FF5555;
                color: white;
                border-radius: 4px;
                padding: 8px 15px;
                font-size: 13px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #FF3333;
            }
        """)
        self.stop_btn.clicked.connect(self.stop_sync)
        control_buttons_layout.addWidget(self.stop_btn)
        
        control_buttons_layout.addStretch()
        left_layout.addLayout(control_buttons_layout)

        # Status Area
        self.status_label = QLabel("Ready to connect")
        self.status_label.setStyleSheet("color: #AAAAAA; font-size: 13px;")
        self.status_label.setWordWrap(True)
        left_layout.addWidget(self.status_label)

        left_layout.addStretch()

        # RIGHT PANEL - Folders and Logs
        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(20, 20, 20, 20)
        right_layout.setSpacing(15)

        # Folders Section
        folders_label = QLabel("Folders (Click to Sync)")
        folders_label.setStyleSheet("color: #FFFFFF; font-size: 16px; font-weight: bold;")
        right_layout.addWidget(folders_label)

        self.folder_tree = QTreeWidget()
        self.folder_tree.setHeaderLabel("Folder Name")
        self.folder_tree.itemClicked.connect(self.on_folder_clicked)
        self.folder_tree.setStyleSheet("""
            QTreeWidget {
                background-color: #2A2A2A;
                border: 2px solid #555555;
                border-radius: 8px;
                color: white;
                font-size: 14px;
            }
            QTreeWidget::item {
                padding: 10px;
                border-bottom: 1px solid #3A3A3A;
            }
            QTreeWidget::item:hover {
                background-color: #3A3A3A;
            }
            QTreeWidget::item:selected {
                background-color: #4A90E2;
                color: white;
            }
            QHeaderView::section {
                background-color: #333333;
                color: white;
                border: none;
                padding: 8px;
                font-weight: bold;
                font-size: 14px;
            }
        """)
        right_layout.addWidget(self.folder_tree, 3)  # 3 parts height

        # Log Section
        log_header = QHBoxLayout()
        log_label = QLabel("Sync Log")
        log_label.setStyleSheet("color: #FFFFFF; font-size: 16px; font-weight: bold;")
        log_header.addWidget(log_label)
        log_header.addStretch()
        
        clear_log_btn = QPushButton("Clear Logs")
        clear_log_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        clear_log_btn.setStyleSheet("""
            QPushButton {
                background-color: transparent;
                color: #4A90E2;
                border: 1px solid #4A90E2;
                border-radius: 4px;
                padding: 6px 12px;
                font-size: 12px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #4A90E2;
                color: white;
            }
        """)
        log_header.addWidget(clear_log_btn)
        
        right_layout.addLayout(log_header)

        self.log_area = QTextEdit()
        self.log_area.setReadOnly(True)
        self.log_area.setStyleSheet("""
            QTextEdit {
                background-color: #1E1E1E;
                border: 2px solid #555555;
                border-radius: 8px;
                color: #DDDDDD;
                font-family: 'Menlo', 'Consolas', 'Monaco', monospace;
                font-size: 12px;
                padding: 10px;
            }
        """)
        right_layout.addWidget(self.log_area, 1)  # 1 part height
        
        # Connect clear button after log_area is created
        clear_log_btn.clicked.connect(self.log_area.clear)

        # Add panels to splitter
        splitter.addWidget(left_panel)
        splitter.addWidget(right_panel)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 2)
        
        main_layout.addWidget(splitter)
        
        # Track connection state
        self.is_connected = False

    def start_connection(self):
        # Check if already connected - if so, disconnect
        if self.is_connected:
            self.disconnect_from_server()
            return
        
        server = self.server_input.text().strip()
        port = self.port_input.text().strip()
        user = self.user_input.text().strip()
        password = self.pass_input.text()

        if not all([server, port, user, password]):
            self.status_label.setText("Please fill all fields")
            self.status_label.setStyleSheet("color: #FF5555; font-weight: bold;")
            return

        # Save Settings
        self.settings.setValue("server", server)
        self.settings.setValue("port", port)
        self.settings.setValue("user", user)

        self.connect_btn.setEnabled(False)
        self.status_label.setText("Connecting...")
        self.status_label.setStyleSheet("color: #4A90E2; font-weight: bold;")
        self.log_area.clear()
        self.folder_tree.clear()

        self.thread = ConnectionThread(server, port, user, password)
        self.thread.connection_result.connect(self.handle_connection_result)
        self.thread.folders_result.connect(self.handle_folders_result)
        self.thread.finished.connect(lambda: self.connect_btn.setEnabled(True))
        self.thread.start()
    
    def disconnect_from_server(self):
        """Disconnect from IMAP server"""
        self.is_connected = False
        
        # Re-enable form fields
        self.server_input.setEnabled(True)
        self.port_input.setEnabled(True)
        self.user_input.setEnabled(True)
        self.pass_input.setEnabled(True)
        
        # Change button back to Connect
        self.connect_btn.setText("Connect to Server")
        self.connect_btn.setStyleSheet("""
            QPushButton {
                background-color: #4A90E2;
                color: white;
                border-radius: 8px;
                font-weight: bold;
                font-size: 16px;
                border: none;
                margin-top: 10px;
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
        
        # Clear folders and update status
        self.folder_tree.clear()
        self.status_label.setText("Disconnected from server")
        self.status_label.setStyleSheet("color: #AAAAAA; font-size: 13px;")
        self.log_area.append("[Disconnected from server]")

    def handle_connection_result(self, success, message):
        color = "#50C878" if success else "#FF5555"
        self.status_label.setText(message)
        self.status_label.setStyleSheet(f"color: {color}; font-weight: bold;")
        
        if success:
            self.is_connected = True
            self.log_area.append(f"[{message}]")
            
            # Disable form fields when connected
            self.server_input.setEnabled(False)
            self.port_input.setEnabled(False)
            self.user_input.setEnabled(False)
            self.pass_input.setEnabled(False)
            
            # Change button to Disconnect
            self.connect_btn.setText("Disconnect from IMAP Server")
            self.connect_btn.setStyleSheet("""
                QPushButton {
                    background-color: #FF5555;
                    color: white;
                    border-radius: 8px;
                    font-weight: bold;
                    font-size: 16px;
                    border: none;
                    margin-top: 10px;
                }
                QPushButton:hover {
                    background-color: #FF3333;
                }
                QPushButton:pressed {
                    background-color: #CC0000;
                }
                QPushButton:disabled {
                    background-color: #555555;
                    color: #AAAAAA;
                }
            """)

    def handle_folders_result(self, folders):
        self.log_area.append("Fetching folders...")
        
        # Parse and sort folders
        parsed_folders = []
        for folder_raw in folders:
            try:
                # Extract name between last set of quotes
                if '"' in folder_raw:
                    name = folder_raw.split('"')[-2]
                else:
                    name = folder_raw.split(' ')[-1]
                parsed_folders.append(name)
            except:
                parsed_folders.append(folder_raw)
        
        parsed_folders.sort()

        # Build tree structure
        tree = {}
        for path in parsed_folders:
            parts = path.split('/')
            current = tree
            for part in parts:
                if part not in current:
                    current[part] = {}
                current = current[part]

        # Recursive add to widget
        def add_items(node, parent_item):
            for key in sorted(node.keys()):
                item = QTreeWidgetItem(parent_item, [key])
                item.setData(0, Qt.ItemDataRole.UserRole, key) 
                add_items(node[key], item)

        # Root items
        for key in sorted(tree.keys()):
            item = QTreeWidgetItem(self.folder_tree, [key])
            item.setData(0, Qt.ItemDataRole.UserRole, key)
            add_items(tree[key], item)
            
        self.folder_tree.expandAll()

    def on_folder_clicked(self, item, column):
        folder_name = item.text(0)
        
        # Reconstruct path
        path_parts = []
        curr = item
        while curr:
            path_parts.insert(0, curr.text(0))
            curr = curr.parent()
        
        full_path = "/".join(path_parts)
        
        self.start_sync(full_path)

    def start_sync(self, folder):
        server = self.server_input.text().strip()
        port = self.port_input.text().strip()
        user = self.user_input.text().strip()
        password = self.pass_input.text()

        # Store the folder for restart functionality
        self.last_synced_folder = folder
        
        self.status_label.setText(f"Syncing {folder}...")
        self.progress_bar.setVisible(True)
        self.progress_bar.setValue(0)
        
        # Hide restart button and show control buttons
        self.hide_restart_button()
        self.pause_btn.setVisible(True)
        self.stop_btn.setVisible(True)
        self.resume_btn.setVisible(False)
        
        # Get access token from auth_client if available
        access_token = None
        if self.auth_client and self.auth_client.access_token:
            access_token = self.auth_client.access_token
        
        self.sync_thread = SyncThread(server, port, user, password, folder, access_token)
        self.sync_thread.progress_update.connect(self.update_progress)
        self.sync_thread.sync_complete.connect(self.on_sync_complete)
        self.sync_thread.error_occurred.connect(self.on_sync_error)
        self.sync_thread.log_message.connect(self.log_area.append)
        self.sync_thread.sync_paused.connect(self.on_sync_paused)
        self.sync_thread.sync_resumed.connect(self.on_sync_resumed)
        self.sync_thread.start()

    def pause_sync(self):
        """Pause the current sync"""
        if hasattr(self, 'sync_thread') and self.sync_thread.isRunning():
            self.sync_thread.pause()
    
    def resume_sync(self):
        """Resume the paused sync"""
        if hasattr(self, 'sync_thread') and self.sync_thread.isRunning():
            self.sync_thread.resume()
    
    def stop_sync(self):
        """Stop the current sync"""
        if hasattr(self, 'sync_thread') and self.sync_thread.isRunning():
            # Hide control buttons immediately
            self.hide_control_buttons()
            
            self.sync_thread.stop()
            # Don't block UI - let thread finish asynchronously
            self.sync_thread.finished.connect(self.on_sync_stopped)
            self.status_label.setText("⏹️ Stopping sync...")
            self.status_label.setStyleSheet("color: #FF5555; font-weight: bold;")
    
    def on_sync_stopped(self):
        """Called when sync thread finishes after stop"""
        self.status_label.setText("⏹️ Sync stopped")
        
        # Show restart button
        if hasattr(self, 'last_synced_folder'):
            self.show_restart_button()
    
    def restart_sync(self):
        """Restart the last sync - clears cache and starts fresh"""
        if hasattr(self, 'last_synced_folder'):
            # Clear logs and progress
            self.log_area.clear()
            self.progress_bar.setValue(0)
            
            # Hide restart and start fresh sync
            self.hide_restart_button()
            self.start_sync(self.last_synced_folder)
    
    def show_restart_button(self):
        """Show the restart sync button (replaces stop button)"""
        # Hide all control buttons
        self.pause_btn.setVisible(False)
        self.resume_btn.setVisible(False)
        self.stop_btn.setVisible(False)
        
        # Show restart button at stop button's position
        if not hasattr(self, 'restart_btn'):
            self.restart_btn = QPushButton("🔄 Restart Sync")
            self.restart_btn.setCursor(Qt.CursorShape.PointingHandCursor)
            self.restart_btn.setStyleSheet("""
                QPushButton {
                    background-color: #4A90E2;
                    color: white;
                    border-radius: 4px;
                    padding: 8px 15px;
                    font-size: 13px;
                    font-weight: bold;
                }
                QPushButton:hover {
                    background-color: #357ABD;
                }
            """)
            self.restart_btn.clicked.connect(self.restart_sync)
            # Add to the same layout as other control buttons
            control_layout = self.stop_btn.parent().layout()
            if control_layout:
                # Replace stop button with restart button at same index
                stop_index = control_layout.indexOf(self.stop_btn)
                control_layout.insertWidget(stop_index, self.restart_btn)
        
        self.restart_btn.setVisible(True)
    
    def hide_restart_button(self):
        """Hide the restart sync button"""
        if hasattr(self, 'restart_btn'):
            self.restart_btn.setVisible(False)
    
    def on_sync_paused(self):
        """Handle sync paused event"""
        self.pause_btn.setVisible(False)
        self.resume_btn.setVisible(True)
        self.status_label.setText("⏸️ Sync paused - Click Resume to continue")
        self.status_label.setStyleSheet("color: #FFA500; font-weight: bold;")
    
    def on_sync_resumed(self):
        """Handle sync resumed event"""
        self.pause_btn.setVisible(True)
        self.resume_btn.setVisible(False)
        # Update status to show syncing again
        if hasattr(self, 'sync_thread'):
            self.status_label.setText("▶️ Sync resumed...")
            self.status_label.setStyleSheet("color: #4A90E2; font-weight: bold;")
    
    def hide_control_buttons(self):
        """Hide all sync control buttons"""
        self.pause_btn.setVisible(False)
        self.resume_btn.setVisible(False)
        self.stop_btn.setVisible(False)

    def update_progress(self, current, total):
        self.progress_bar.setMaximum(total)
        self.progress_bar.setValue(current)
        
        # Update status with percentage and ETA
        percentage = (current / total * 100) if total > 0 else 0
        self.status_label.setText(f"Syncing: {current:,} / {total:,} ({percentage:.1f}%)")
        self.status_label.setStyleSheet("color: #4A90E2; font-weight: bold;")

    def on_sync_complete(self, message):
        self.status_label.setText(message)
        self.status_label.setStyleSheet("color: #50C878; font-weight: bold;")
        self.progress_bar.setVisible(False)
        self.hide_control_buttons()
        self.show_restart_button()

    def on_sync_error(self, message):
        self.status_label.setText(message)
        self.status_label.setStyleSheet("color: #FF5555; font-weight: bold;")
        self.progress_bar.setVisible(False)
        self.hide_control_buttons()
        self.show_restart_button()
        self.log_area.append(f"Error: {message}")


