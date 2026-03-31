from typing import TypeVar, Generic, Dict, Any, Optional
from pydantic import BaseModel, Field
from encoding_library.models.data_type import DataType

# T is a generic type variable that can be bound to EmailModel, NotesModel, etc.
T = TypeVar('T', bound=BaseModel)

class MemoryRequest(BaseModel, Generic[T]):
    """
    Standard format for incoming API requests to the Ingestion server.
    """
    data_type: DataType = Field(alias="dataType")
    client: str
    data: T
    model_type: Optional[str] = None
    model_name: Optional[str] = None
    chunking_type: Optional[str] = None
    chunking_technique: Optional[str] = None
    
    class Config:
        populate_by_name = True
        alias_generator = lambda string: ''.join(word.capitalize() if i > 0 else word for i, word in enumerate(string.split('_')))
