from enum import Enum

class ChunkingType(Enum):
    RECURSIVE = "recursive"
    SEMANTIC = "semantic"
    # Agentic, Markdown, etc. can be added here

class RecursiveTechnique(Enum):
    CHARACTER = "character"
    TOKEN = "token"


