from enum import Enum

class ModelType(Enum):
    SENTENCE_TRANSFORMER = "sentence-transformer"
    OPENAI = "openai"
    COHERE = "cohere"

class ModelName(Enum):
    ALL_MINILM_L6_V2 = "all-MiniLM-L6-v2"
    # Add other model names as needed
    TEXT_EMBEDDING_3_SMALL = "text-embedding-3-small"
