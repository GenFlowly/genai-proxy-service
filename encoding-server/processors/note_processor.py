import json
import logging
from typing import Dict, Any, Tuple
from .data_processor import DataProcessor
from models.payload import Payload

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
        message_attributes = {}
        
        attributes_map = {
            'noteKey': notes_model.note_key,
            'noteValue': notes_model.note_value,
            'title': notes_model.title,
            'createdAt': notes_model.created_at,
            'type': 'note',
            'client': notes_model.client,
            'customerId': payload.customer_id
        }

        for key, value in attributes_map.items():
            if value: # Only add if not None and not empty string
                message_attributes[key] = {
                    'StringValue': str(value),
                    'DataType': 'String'
                }
        
        return message_body, message_attributes

    def prepare_for_vector_db(self, data: Dict[str, Any], embedding: list) -> Dict[str, Any]:
        """
        Prepare note data for insertion into Zilliz/Milvus.
        """
        notes_model = NotesModel.from_dict(data)
        
        return {
            "id": notes_model.note_key,
            "vector": embedding,
            "note_value": notes_model.note_value[:65535], # Limit size if necessary
            "title": notes_model.title[:500],
            "client": notes_model.client[:100],
            "created_at": notes_model.created_at,
            "s3_key": f"notes/{notes_model.client}/{notes_model.note_key}.json"
        }
