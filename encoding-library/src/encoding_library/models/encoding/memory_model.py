import uuid
from typing import Dict, Any, Optional
from pydantic import BaseModel, ConfigDict


class MemoryModel(BaseModel):
    """A long-term user memory extracted from conversations/notes by the proxy.

    memory_key is the CustomerMemory DDB sort key ("MEM#<uuid>"), so vectors can
    be deleted by filter when the memory is updated or forgotten.
    """
    memory_key: str = ''
    memory_value: str = ''
    title: Optional[str] = None
    created_at: str = ''

    model_config = ConfigDict(populate_by_name=True)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return self.model_dump(by_alias=True, exclude_none=True)

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'MemoryModel':
        """Create MemoryModel from dictionary (accepts camelCase copies too)."""
        return MemoryModel(
            memory_key=data.get('memory_key', data.get('memoryKey', str(uuid.uuid4()))),
            memory_value=data.get('memory_value', data.get('memoryValue', '')),
            title=data.get('title'),
            created_at=data.get('created_at', data.get('createdAt', '')),
        )
