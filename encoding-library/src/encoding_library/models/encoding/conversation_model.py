from typing import Dict, Any, Optional
from pydantic import BaseModel, ConfigDict


class ConversationModel(BaseModel):
    """One completed user/assistant exchange of a conversation.

    conversation_key is the conversation id (groups all chunk rows of a
    conversation so search hits can be deduped to conversations and vectors
    deleted by filter). message_key is the assistant message id of the
    exchange — unique per exchange, so chunk ids never collide as the
    conversation grows.
    """
    conversation_key: str = ''
    message_key: str = ''
    text: str = ''
    title: Optional[str] = None
    created_at: str = ''

    model_config = ConfigDict(populate_by_name=True)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return self.model_dump(by_alias=True, exclude_none=True)

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'ConversationModel':
        """Create ConversationModel from dictionary (accepts camelCase copies too)."""
        return ConversationModel(
            conversation_key=data.get('conversation_key', data.get('conversationKey', '')),
            message_key=data.get('message_key', data.get('messageKey', '')),
            text=data.get('text', ''),
            title=data.get('title'),
            created_at=data.get('created_at', data.get('createdAt', '')),
        )
