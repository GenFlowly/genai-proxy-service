import json
import logging
from typing import Dict, Any, Tuple, List, Callable
from .data_processor import DataProcessor
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.encoders.encoder import Encoder

from encoding_library.models.encoding.email_model import EmailModel

logger = logging.getLogger()

class EmailProcessor(DataProcessor):
    """
    Processor for Email data.
    """

    def validate(self, data: Dict[str, Any]) -> bool:
        """
        Validate that the data is a valid email.
        """
        required_fields = ['message_id', 'subject', 'body', 'from', 'to', 'date', 'folder']
        missing_fields = [field for field in required_fields if field not in data]
        
        if missing_fields:
            raise ValueError(f"Missing required fields: {missing_fields}")
        
        # Validate EmailModel can be created
        try:
            email_model = EmailModel.from_dict(data)
            logger.info(f"Validated EmailModel for message_id: {email_model.message_id}")
        except Exception as e:
            raise ValueError(f"Invalid EmailModel data: {str(e)}")
            
        return True



    def to_sqs_message(self, state: MemoryRequestInternalState) -> Tuple[str, Dict[str, Any]]:
        """
        Convert email data to SQS message format.
        state.raw_data contains the email dictionary.
        """
        # Validate/Process email data from state
        email_model = EmailModel.from_dict(state.raw_data)
        
        # We update state.raw_data with the processed model dict (standardized)
        state.raw_data = email_model.to_dict()
        
        # Serialize the entire state object
        message_body = json.dumps(state.to_dict())
        
        message_attributes = {
            'customerId': {
                'StringValue': state.customer_id,
                'DataType': 'String'
            }
        }
        
        return message_body, message_attributes

    def prepare_for_vector_db(self, data: Dict[str, Any], embeddings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Prepare email data for insertion into Zilliz/Milvus.
        Returns a list of records (single record for email for now).
        """
        email_model = EmailModel.from_dict(data)
        
        # We assume email currently maps to a single vector/chunk
        # In future we might chunk emails too
        embedding_vector = []
        if embeddings and len(embeddings) > 0:
            embedding_vector = embeddings[0]['vector']
            
        record = {
            "id": email_model.message_id,
            "vector": embedding_vector,
            "subject": email_model.subject[:500],  # Limit field size
            "from_email": email_model.from_addr[:200],
            "to_email": ", ".join(email_model.to_addrs)[:200],  # Join list to string
            "date": email_model.date.isoformat() if email_model.date else "",
            "folder": email_model.folder[:100],
            "thread_id": (email_model.thread_id or "")[:200],
            "in_reply_to": (email_model.in_reply_to or "")[:200],
            "s3_key": f"emails/{email_model.folder}/{email_model.message_id}.json"
        }
        
        return [record]

    def create_embeddings(self, data: Dict[str, Any], encoder: Encoder) -> List[Dict[str, Any]]:
        """
        Create embeddings for the email.
        """
        # Create EmailModel to get text
        email = EmailModel.from_dict(data)
        logger.info(f"Encoding email: {email.message_id}")

        text_to_encode = f"{email.subject} {email.body}"
        
        # We treat the whole email as one chunk for now to maintain existing behavior
        # But for new interface we need to use encoder.encode_documents
        
        # Expect encoder to have encode_documents method
        if hasattr(encoder, 'encode_documents'):
            embeddings = encoder.encode_documents([text_to_encode])
        else:
             # Fallback 
             raise ValueError("Encoder does not support encode_documents")
        
        if not embeddings:
            return []
            
        # We only sent one document, so we expect one embedding
        embedding = embeddings[0]
            
        vector = embedding
        if hasattr(vector, 'tolist'):
            vector = vector.tolist()
        else:
            vector = list(vector)
            
        return [{'text': text_to_encode[:100], 'vector': vector, 'index': 0}]

    def get_collection_name(self, customer_id: str, data: Dict[str, Any]) -> str:
        """
        Get the name of the vector database collection for this data type.
        """
        model_name = data.get('model_name', 'all-MiniLM-L6-v2')
        # Sanitize model name for Milvus collection name (replace hyphens with underscores)
        safe_model_name = model_name.replace('-', '_')
        return f"{customer_id}_email_{safe_model_name}"
        
    def get_collection_schema(self) -> Any:
        """
        Get the Milvus schema definition for email type.
        """
        # Lazy import heavy PyMilvus libraries
        try:
            from pymilvus import MilvusClient, DataType
        except ImportError:
            import sys, os
            sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            from pymilvus import MilvusClient, DataType

        schema = MilvusClient.create_schema(
            auto_id=False,
            enable_dynamic_field=True,
        )
        
        # Add fields
        schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=256, is_primary=True)
        schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=384)
        schema.add_field(field_name="subject", datatype=DataType.VARCHAR, max_length=512)
        schema.add_field(field_name="from_email", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="to_email", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="date", datatype=DataType.VARCHAR, max_length=64)
        schema.add_field(field_name="folder", datatype=DataType.VARCHAR, max_length=128)
        schema.add_field(field_name="thread_id", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="in_reply_to", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="s3_key", datatype=DataType.VARCHAR, max_length=512)
        
        index_params = MilvusClient.prepare_index_params()
        
        index_params.add_index(
            field_name="vector", 
            index_type="AUTOINDEX",
            metric_type="COSINE"
        )
        
        return schema, index_params
