import json
import logging
from typing import Dict, Any, Tuple, List, Callable
from .data_processor import DataProcessor
from encoding_library.models.payload import Payload
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

    def to_sqs_message(self, payload: Payload) -> Tuple[str, Dict[str, Any]]:
        """
        Convert note data to SQS message format.
        Payload.data contains the note dictionary.
        """
        # Validate/Process note data from payload
        notes_model = NotesModel.from_dict(payload.data)
        
        # We update payload.data with the processed model dict (standardized)
        payload.data = notes_model.to_dict()
        
        # Serialize the entire Payload object
        message_body = json.dumps(payload.to_dict())
        
        # Helper to safely add string attributes
        message_attributes = {
            'customerId': {
                'StringValue': str(payload.customer_id),
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
                "client": notes_model.client[:100],
                "created_at": notes_model.created_at,
                "s3_key": f"notes/{notes_model.client}/{data_id}.json",
                # Optional: Add chunk specific metadata if schema supports it
                # "chunk_index": chunk_index 
            }
            records.append(record)
            
        return records



    def create_embeddings(self, data: Dict[str, Any], encoder: Encoder) -> List[Dict[str, Any]]:
        """
        Create embeddings for the note using configured chunker and encoder.
        """
        note = NotesModel.from_dict(data)
        logger.info(f"Encoding note: {note.note_value[:100]}...")

        text_to_encode = f"{note.title or ''}\n\n{note.note_value}"

        from encoding_library.chunkers.factory import ChunkerFactory
        from encoding_library.chunkers.enums import ChunkingType, RecursiveTechnique
        
        # Get chunking config from data or use defaults
        # We can pass strings, Factory will normalize
        chunking_type_str = data.get('chunking_type', ChunkingType.RECURSIVE.value)
        chunking_technique_str = data.get('chunking_technique', RecursiveTechnique.CHARACTER.value)
        
        # Get chunker
        # Pass encoder as kwarg for semantic chunking if needed
        chunker = ChunkerFactory.get_chunker(
            chunking_type=chunking_type_str,
            technique=chunking_technique_str,
            encoder=encoder
        )
        
        # Chunk text
        chunks = chunker.chunk(text_to_encode)
        
        if not chunks:
            return []
            
        # Encode chunks
        embeddings = encoder.encode_documents(chunks)
             
        # Format result
        result = []
        for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
            vector = embedding
            if hasattr(vector, 'tolist'):
                vector = vector.tolist()
            else:
                vector = list(vector)
                
            result.append({
                'text': chunk_text,
                'vector': vector,
                'index': i
            })
            
        return result

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
