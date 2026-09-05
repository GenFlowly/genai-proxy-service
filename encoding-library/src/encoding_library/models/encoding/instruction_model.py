import uuid
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class InstructionModel(BaseModel):
    instruction_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    version: int = 1
    name: Optional[str] = None
    instructions: str = ''
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    created_at: str = ''

    model_config = ConfigDict(populate_by_name=True)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return self.model_dump(by_alias=True, exclude_none=True)

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'InstructionModel':
        """Create InstructionModel from dictionary (snake_case or camelCase keys)."""
        return InstructionModel(
            instruction_id=data.get('instruction_id', data.get('instructionId', str(uuid.uuid4()))),
            version=int(data.get('version', 1)),
            name=data.get('name'),
            instructions=data.get('instructions', ''),
            category=data.get('category'),
            tags=data.get('tags'),
            created_at=data.get('created_at', data.get('createdAt', '')),
        )
