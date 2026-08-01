from typing import Optional
from pydantic import BaseModel


class RawData(BaseModel):
    query_data: str
    top_n: int = 3
    search_params: dict = {"metric_type": "COSINE", "params": {"nprobe": 10}}
    similarity_threshold: float = 0.6


class ConversationMessage(BaseModel):
    role: str
    content: str


class RetrieveRequest(BaseModel):
    customer_id: str
    client: str
    data_type: str
    raw_data: RawData
    llm_credentials: dict
    llm_provider: str = "openai"
    llm_model: Optional[str] = None
    llm_max_tokens: int = 4096
    conversation_history: list[ConversationMessage] = []
    model_type: Optional[str] = None
    model_name: Optional[str] = None
    system_prompt: Optional[str] = None
    stream: bool = False
