import json
import logging
from typing import Dict, Any, Tuple, List, Callable
from .data_processor import DataProcessor
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.encoders.encoder import Encoder
import uuid

# Assuming notes_model is in the python path
try:
    from models.encoding.notes_model import NotesModel
except ImportError:
    # Fallback for local development
    import sys
    import os
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models.encoding.notes_model import NotesModel


logger = logging.getLogger()

class NoteProcessor(DataProcessor):
    """
    Processor for Note data.
    """

    def validate(self, data: Dict[str, Any]) -> bool:
        """
        Validate that the data is a valid note.
        Checks for note_value, client, and created_at.
        """
        required_fields = ['note_value', 'client', 'created_at']
        missing_fields = [field for field in required_fields if field not in data]
        
        if missing_fields:
            raise ValueError(f"Missing required fields: {missing_fields}")
        
        # Validate NotesModel can be created
        try:
            notes_model = NotesModel.from_dict(data)
            logger.info(f"Validated NotesModel for note_key: {notes_model.note_key}")
        except Exception as e:
            raise ValueError(f"Invalid NotesModel data: {str(e)}")
            
        return True

    def to_sqs_message(self, memory_request_internal_state: MemoryRequestInternalState) -> Tuple[str, Dict[str, Any]]:
        """
        Convert note data to SQS message format.
        state.raw_data contains the note dictionary.
        """
        # Validate/Process note data from state
        notes_model = NotesModel.from_dict(memory_request_internal_state.raw_data)
        
        # We update state.raw_data with the processed model dict (standardized)
        memory_request_internal_state.raw_data = notes_model.to_dict()
        
        # Serialize the entire state object
        message_body = json.dumps(memory_request_internal_state.to_dict())
        
        # Helper to safely add string attributes
        message_attributes = {
            'customerId': {
                'StringValue': str(memory_request_internal_state.customer_id),
                'DataType': 'String'
            }
        }
        
        return message_body, message_attributes

    def prepare_for_vector_db(self, data: Dict[str, Any], embeddings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Prepare note data for insertion into Zilliz/Milvus.
        Returns a list of records, one per chunk.
        """
        notes_model = NotesModel.from_dict(data)
        
        # Ensure note_key is present (required for ID)
        if not notes_model.note_key:
            notes_model.note_key = str(uuid.uuid4())
            logger.info(f"Generated UUID for missing note_key: {notes_model.note_key}")
        
        records = []
        
        for chunk_data in embeddings:
            # id is internal Milvus ID (UUID), note_key is optional external ID
            data_id = str(uuid.uuid4())
            chunk_text = chunk_data['text']
            vector = chunk_data['vector']
            chunk_index = chunk_data['index']
            
            record = {
                "id": data_id,
                "vector": vector,
                "note_value": chunk_text[:65535], # Store the CHUNK text, not the whole note
                "title": (notes_model.title or "")[:500],
                "note_key": (notes_model.note_key or "")[:256],
                "client": str(data.get('client', 'unknown_client'))[:100],
                "created_at": notes_model.created_at,
                "s3_key": f"notes/{data.get('client', 'unknown_client')}/{data_id}.json",
                # Optional: Add chunk specific metadata if schema supports it
                # "chunk_index": chunk_index 
            }
            records.append(record)
            
        return records



    def get_text_to_encode(self, data: Dict[str, Any]) -> str:
        """
        Extract the raw text string for a Note.
        """
        note = NotesModel.from_dict(data)
        logger.info(f"Extracting text for note: {note.note_value[:100]}...")
        
        return f"{note.title or ''}\n\n{note.note_value}"

    def get_collection_name(self, customer_id: str, data: Dict[str, Any]) -> str:
        """
        Get the name of the vector database collection for this data type.
        """
        model_name = data.get('model_name', 'all-MiniLM-L6-v2')
        # Sanitize model name for Milvus collection name (replace hyphens with underscores)
        safe_model_name = model_name.replace('-', '_')
        return f"{customer_id}_notes_{safe_model_name}"
        
    def get_collection_schema(self) -> Any:
        """
        Get the Milvus schema definition for note type.
        """
        # Lazy import heavy PyMilvus libraries
        try:
            from pymilvus import MilvusClient, DataType
        except ImportError:
            import sys, os
            sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            from pymilvus import MilvusClient, DataType

        notes_schema = MilvusClient.create_schema(
            auto_id=False,
            enable_dynamic_field=True,
        )
        
        # Add fields for Notes
        notes_schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=256, is_primary=True)
        notes_schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=384) # Using all-MiniLM-L6-v2 which is 384 dim
        notes_schema.add_field(field_name="note_value", datatype=DataType.VARCHAR, max_length=65535)
        notes_schema.add_field(field_name="title", datatype=DataType.VARCHAR, max_length=512)
        notes_schema.add_field(field_name="note_key", datatype=DataType.VARCHAR, max_length=256)
        notes_schema.add_field(field_name="client", datatype=DataType.VARCHAR, max_length=100)
        notes_schema.add_field(field_name="created_at", datatype=DataType.VARCHAR, max_length=64)
        notes_schema.add_field(field_name="s3_key", datatype=DataType.VARCHAR, max_length=512)
        
        notes_index_params = MilvusClient.prepare_index_params()
        
        notes_index_params.add_index(
            field_name="vector", 
            index_type="AUTOINDEX",
            metric_type="COSINE"
        )
        
        return notes_schema, notes_index_params
