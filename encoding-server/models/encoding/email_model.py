from dataclasses import dataclass, field
from typing import List, Optional
from datetime import datetime
import email.utils
from email.header import decode_header

@dataclass
class EmailModel:
    message_id: str
    subject: str
    from_addr: str
    to_addrs: List[str]
    date: datetime
    body: str
    folder: str
    references: List[str] = field(default_factory=list)
    in_reply_to: Optional[str] = None
    thread_id: Optional[str] = None # Can be derived or assigned by server

    def to_dict(self):
        return {
            "message_id": self.message_id,
            "subject": self.subject,
            "from": self.from_addr,
            "to": self.to_addrs,
            "date": self.date.isoformat() if self.date else None,
            "body": self.body,
            "folder": self.folder,
            "references": self.references,
            "in_reply_to": self.in_reply_to,
            "thread_id": self.thread_id
        }

    @staticmethod
    def decode_subject(subject):
        """Decode MIME-encoded email subject."""
        if not subject:
            return ""
        
        decoded_parts = []
        for part, encoding in decode_header(subject):
            if isinstance(part, bytes):
                # Decode bytes to string
                if encoding:
                    try:
                        decoded_parts.append(part.decode(encoding))
                    except:
                        decoded_parts.append(part.decode('utf-8', errors='replace'))
                else:
                    decoded_parts.append(part.decode('utf-8', errors='replace'))
            else:
                decoded_parts.append(part)
        
        return ''.join(decoded_parts)

    @staticmethod
    def from_message(msg, folder_name):
        # Helper to parse email.message.Message object
        raw_subject = msg.get("Subject", "")
        subject = EmailModel.decode_subject(raw_subject)
        
        from_addr = msg.get("From", "")
        to_addrs = msg.get_all("To", [])
        date_str = msg.get("Date")
        date_obj = None
        if date_str:
            try:
                date_tuple = email.utils.parsedate_tz(date_str)
                if date_tuple:
                    date_obj = datetime.fromtimestamp(email.utils.mktime_tz(date_tuple))
            except:
                pass # Keep None if parsing fails

        message_id = msg.get("Message-ID", "").strip()
        references = msg.get("References", "").split()
        in_reply_to = msg.get("In-Reply-To", "").strip()

        # Body extraction (simplified)
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    try:
                        body = part.get_payload(decode=True).decode(errors='replace')
                        break
                    except:
                        pass
        else:
            try:
                body = msg.get_payload(decode=True).decode(errors='replace')
            except:
                pass

        return EmailModel(
            message_id=message_id,
            subject=subject,
            from_addr=from_addr,
            to_addrs=to_addrs,
            date=date_obj,
            body=body,
            folder=folder_name,
            references=references,
            in_reply_to=in_reply_to
        )

    @staticmethod
    def from_dict(data: dict) -> 'EmailModel':
        """Create EmailModel from dictionary."""
        # Parse date if it's a string
        date = data.get('date')
        if isinstance(date, str):
            date = datetime.fromisoformat(date)
        elif date is None:
            date = datetime.now()
        
        return EmailModel(
            message_id=data.get('message_id', ''),
            subject=data.get('subject', ''),
            from_addr=data.get('from', ''),
            to_addrs=data.get('to', []),
            date=date,
            body=data.get('body', ''),
            folder=data.get('folder', 'inbox'),
            references=data.get('references', []),
            in_reply_to=data.get('in_reply_to'),
            thread_id=data.get('thread_id')
        )
