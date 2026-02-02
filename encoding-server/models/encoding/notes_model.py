from dataclasses import dataclass, asdict
from typing import Dict, Any

@dataclass
class NotesModel:
    note_key: str
    note_value: str
    title: str
    created_at: str
    client: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'NotesModel':
        """Create NotesModel from dictionary."""
        return NotesModel(
            note_key=data.get('note_key', ''),
            note_value=data.get('note_value', ''),
            title=data.get('title', ''),
            created_at=data.get('created_at', ''),
            client=data.get('client', '')
        )
