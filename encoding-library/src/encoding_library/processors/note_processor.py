import json
import logging
import uuid
from typing import Dict, Any, Tuple, List
from .data_processor import DataProcessor
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState

try:
    from models.encoding.notes_model import NotesModel
except ImportError:
    import sys, os
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models.encoding.notes_model import NotesModel

logger = logging.getLogger()


class NoteProcessor(DataProcessor):
    """
    Processor for Note data.
    """

    HEAVY_RAW_FIELDS = frozenset({'note_value', 'noteValue'})

    def validate(self, state: MemoryRequestInternalState) -> bool:
        """
        Validate that the state contains valid note data.
        """
        required_fields = ['note_value', 'created_at']
        missing_fields = [f for f in required_fields if f not in state.raw_data]

        if missing_fields:
            raise ValueError(f"Missing required note fields: {missing_fields}")

        try:
            notes_model = NotesModel.from_dict(state.raw_data)
            logger.info(f"Validated NotesModel for note_key: {notes_model.note_key}")
        except Exception as e:
            raise ValueError(f"Invalid NotesModel data: {str(e)}")

        return True

    def to_sqs_message(self, state: MemoryRequestInternalState) -> Tuple[str, Dict[str, Any]]:
        """
        Convert note state to SQS message format.
        """
        notes_model = NotesModel.from_dict(state.raw_data)
        state.raw_data = notes_model.to_dict()

        message_body = json.dumps(state.to_dict())
        message_attributes = {
            'customerId': {
                'StringValue': str(state.customer_id),
                'DataType': 'String'
            }
        }

        return message_body, message_attributes

    def prepare_for_vector_db(self, state: MemoryRequestInternalState, embeddings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Prepare note data for insertion into Zilliz/Milvus.
        Returns one record per chunk.
        """
        notes_model = NotesModel.from_dict(state.raw_data)


        records = []
        for i, chunk_data in enumerate(embeddings):
            data_id = f"{notes_model.note_key}_{i}"
            record = {
                "id": data_id,
                "vector": chunk_data['vector'],
                "note_value": chunk_data['text'][:65535],
                "title": (notes_model.title or "")[:500],
                "note_key": (notes_model.note_key or "")[:256],
                "client": state.client[:100],
                "created_at": notes_model.created_at,
                # Points at the durable per-note document in the customer-documents
                # bucket ({customerId}/notes/{noteKey}.json). Written by the batch
                # accumulator; realtime-path notes may not have the object yet.
                "s3_key": f"{state.customer_id}/notes/{notes_model.note_key}.json",
            }
            records.append(record)

        return records

    def get_text_to_encode(self, state: MemoryRequestInternalState) -> str:
        """
        Extract the raw text string for a Note.
        """
        note = NotesModel.from_dict(state.raw_data)
        logger.info(f"Extracting text for note: {note.note_value[:100]}...")
        return f"{note.title or ''}\n\n{note.note_value}"

    def get_collection_name(self, state: MemoryRequestInternalState) -> str:
        model_name = state.model_name or 'all-MiniLM-L6-v2'
        safe_model_name = model_name.replace('-', '_')
        return f"{state.customer_id}_notes_{safe_model_name}"

    def get_collection_schema(self, dim: int = 384, description: str = "") -> Any:
        """
        Get the Milvus schema definition for note type.
        """
        try:
            from pymilvus import MilvusClient, DataType
        except ImportError:
            import sys, os
            sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            from pymilvus import MilvusClient, DataType

        schema = MilvusClient.create_schema(auto_id=False, enable_dynamic_field=True, description=description)
        schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=256, is_primary=True)
        schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=dim)
        schema.add_field(field_name="note_value", datatype=DataType.VARCHAR, max_length=65535)
        schema.add_field(field_name="title", datatype=DataType.VARCHAR, max_length=512)
        schema.add_field(field_name="note_key", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="client", datatype=DataType.VARCHAR, max_length=100)
        schema.add_field(field_name="created_at", datatype=DataType.VARCHAR, max_length=64)
        schema.add_field(field_name="s3_key", datatype=DataType.VARCHAR, max_length=512)

        index_params = MilvusClient.prepare_index_params()
        index_params.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")

        return schema, index_params
