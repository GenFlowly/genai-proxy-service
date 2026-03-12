from encoding_library.models.memory_request import MemoryRequest
from encoding_library.models.encoding.notes_model import NotesModel

raw = {
    "dataType": "NOTE",
    "client": "test",
    "data": {
        "note_key": "123",
        "note_value": "hello pydantic",
        "title": "my title"
    }
}

req = MemoryRequest[NotesModel].model_validate(raw)
print(req.model_dump(by_alias=True, exclude_none=True))
