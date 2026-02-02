from dataclasses import dataclass, asdict
from typing import Dict, Any, Optional

@dataclass
class NotesModel:
    note_key: Optional[str] = None
    note_value: str = ''
    title: Optional[str] = None
    created_at: str = ''
    client: str = ''

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            'note_key': self.note_key,
            'note_value': self.note_value,
            'title': self.title,
            'created_at': self.created_at,
            'client': self.client
        }

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'NotesModel':
        """Create NotesModel from dictionary."""
        return NotesModel(
            note_key=data.get('note_key'),
            note_value=data.get('note_value', ''),
            title=data.get('title'),
            created_at=data.get('created_at', ''),
            client=data.get('client', '')
        )
