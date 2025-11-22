import sqlite3
import os
from datetime import datetime
from typing import Optional, List, Dict
import json

class SyncDatabase:
    def __init__(self, db_path="email_sync.db"):
        self.db_path = db_path
        self.conn = None
        self.init_db()
    
    def init_db(self):
        """Initialize database and create tables"""
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        
        cursor = self.conn.cursor()
        
        # Sync sessions table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS sync_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                folder TEXT NOT NULL,
                start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                end_time TIMESTAMP,
                status TEXT DEFAULT 'in_progress',
                total_emails INTEGER DEFAULT 0,
                synced_emails INTEGER DEFAULT 0,
                failed_emails INTEGER DEFAULT 0
            )
        ''')
        
        # Synced emails table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS synced_emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER,
                message_id TEXT NOT NULL,
                folder TEXT NOT NULL,
                sync_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'success',
                error_message TEXT,
                FOREIGN KEY (session_id) REFERENCES sync_sessions(id),
                UNIQUE(message_id, folder)
            )
        ''')
        
        # Checkpoints table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS checkpoints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER,
                checkpoint_num INTEGER,
                emails_synced INTEGER,
                last_message_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sync_sessions(id)
            )
        ''')
        
        # Create indexes
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_message_id ON synced_emails(message_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_folder ON synced_emails(folder)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_session ON synced_emails(session_id)')
        
        self.conn.commit()
    
    def create_session(self, folder: str, total_emails: int = 0) -> int:
        """Create a new sync session"""
        cursor = self.conn.cursor()
        cursor.execute('''
            INSERT INTO sync_sessions (folder, total_emails)
            VALUES (?, ?)
        ''', (folder, total_emails))
        self.conn.commit()
        return cursor.lastrowid
    
    def update_session(self, session_id: int, synced: int = 0, failed: int = 0, status: str = None):
        """Update sync session progress"""
        cursor = self.conn.cursor()
        
        updates = []
        params = []
        
        if synced > 0:
            updates.append("synced_emails = synced_emails + ?")
            params.append(synced)
        
        if failed > 0:
            updates.append("failed_emails = failed_emails + ?")
            params.append(failed)
        
        if status:
            updates.append("status = ?")
            params.append(status)
            if status in ['completed', 'failed']:
                updates.append("end_time = CURRENT_TIMESTAMP")
        
        if updates:
            params.append(session_id)
            cursor.execute(f'''
                UPDATE sync_sessions 
                SET {', '.join(updates)}
                WHERE id = ?
            ''', params)
            self.conn.commit()
    
    def mark_email_synced(self, session_id: int, message_id: str, folder: str, status: str = 'success', error: str = None):
        """Mark an email as synced"""
        cursor = self.conn.cursor()
        try:
            cursor.execute('''
                INSERT OR REPLACE INTO synced_emails (session_id, message_id, folder, status, error_message)
                VALUES (?, ?, ?, ?, ?)
            ''', (session_id, message_id, folder, status, error))
            self.conn.commit()
            return True
        except Exception as e:
            print(f"Error marking email synced: {e}")
            return False
    
    def is_email_synced(self, message_id: str, folder: str) -> bool:
        """Check if an email has already been synced"""
        cursor = self.conn.cursor()
        cursor.execute('''
            SELECT COUNT(*) FROM synced_emails 
            WHERE message_id = ? AND folder = ? AND status = 'success'
        ''', (message_id, folder))
        return cursor.fetchone()[0] > 0
    
    def save_checkpoint(self, session_id: int, checkpoint_num: int, emails_synced: int, last_message_id: str):
        """Save a checkpoint for resumable sync"""
        cursor = self.conn.cursor()
        cursor.execute('''
            INSERT INTO checkpoints (session_id, checkpoint_num, emails_synced, last_message_id)
            VALUES (?, ?, ?, ?)
        ''', (session_id, checkpoint_num, emails_synced, last_message_id))
        self.conn.commit()
    
    def get_last_checkpoint(self, folder: str) -> Optional[Dict]:
        """Get the last checkpoint for a folder"""
        cursor = self.conn.cursor()
        cursor.execute('''
            SELECT c.* FROM checkpoints c
            JOIN sync_sessions s ON c.session_id = s.id
            WHERE s.folder = ? AND s.status = 'in_progress'
            ORDER BY c.created_at DESC
            LIMIT 1
        ''', (folder,))
        row = cursor.fetchone()
        if row:
            return dict(row)
        return None
    
    def get_session_stats(self, session_id: int) -> Optional[Dict]:
        """Get statistics for a sync session"""
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM sync_sessions WHERE id = ?', (session_id,))
        row = cursor.fetchone()
        if row:
            return dict(row)
        return None
    
    def get_failed_emails(self, session_id: int) -> List[Dict]:
        """Get list of failed emails for retry"""
        cursor = self.conn.cursor()
        cursor.execute('''
            SELECT * FROM synced_emails 
            WHERE session_id = ? AND status = 'failed'
            ORDER BY id
        ''', (session_id,))
        return [dict(row) for row in cursor.fetchall()]
    
    def close(self):
        """Close database connection"""
        if self.conn:
            self.conn.close()
