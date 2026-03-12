from typing import Dict, Any, Optional
from pydantic import BaseModel, ConfigDict, Field

class NotesModel(BaseModel):
    note_key: Optional[str] = None
    note_value: str = ''
    title: Optional[str] = None
    created_at: str = ''
    
    model_config = ConfigDict(populate_by_name=True)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return self.model_dump(by_alias=True, exclude_none=True)

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'NotesModel':
        """Create NotesModel from dictionary."""
        return NotesModel(
            note_key=data.get('note_key'),
            note_value=data.get('note_value', ''),
            title=data.get('title'),
            created_at=data.get('created_at', ''),
        )
