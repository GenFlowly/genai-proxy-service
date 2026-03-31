import json
import logging
from typing import Dict, Any, Tuple, List
from .data_processor import DataProcessor
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.models.encoding.email_model import EmailModel

logger = logging.getLogger()


class EmailProcessor(DataProcessor):
    """
    Processor for Email data.
    """

    def validate(self, state: MemoryRequestInternalState) -> bool:
        """
        Validate that the state contains valid email data.
        """
        required_fields = ['message_id', 'subject', 'body', 'from', 'to', 'date', 'folder']
        missing_fields = [f for f in required_fields if f not in state.raw_data]

        if missing_fields:
            raise ValueError(f"Missing required email fields: {missing_fields}")

        try:
            email_model = EmailModel.from_dict(state.raw_data)
            logger.info(f"Validated EmailModel for message_id: {email_model.message_id}")
        except Exception as e:
            raise ValueError(f"Invalid EmailModel data: {str(e)}")

        return True

    def to_sqs_message(self, state: MemoryRequestInternalState) -> Tuple[str, Dict[str, Any]]:
        """
        Convert email state to SQS message format.
        """
        email_model = EmailModel.from_dict(state.raw_data)
        state.raw_data = email_model.to_dict()

        message_body = json.dumps(state.to_dict())
        message_attributes = {
            'customerId': {
                'StringValue': state.customer_id,
                'DataType': 'String'
            }
        }

        return message_body, message_attributes

    def prepare_for_vector_db(self, state: MemoryRequestInternalState, embeddings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Prepare email data for insertion into Zilliz/Milvus.
        """
        email_model = EmailModel.from_dict(state.raw_data)

        embedding_vector = embeddings[0]['vector'] if embeddings else []

        record = {
            "id": email_model.message_id,
            "vector": embedding_vector,
            "subject": email_model.subject[:500],
            "from_email": email_model.from_addr[:200],
            "to_email": ", ".join(email_model.to_addrs)[:200],
            "date": email_model.date.isoformat() if email_model.date else "",
            "folder": email_model.folder[:100],
            "thread_id": (email_model.thread_id or "")[:200],
            "in_reply_to": (email_model.in_reply_to or "")[:200],
            "s3_key": f"emails/{email_model.folder}/{email_model.message_id}.json"
        }

        return [record]

    def get_text_to_encode(self, state: MemoryRequestInternalState) -> str:
        """
        Extract the raw text string for an Email.
        """
        email = EmailModel.from_dict(state.raw_data)
        logger.info(f"Extracting text for email: {email.message_id}")
        return f"{email.subject}\n\n{email.body}"

    def get_collection_name(self, state: MemoryRequestInternalState) -> str:
        """
        Get the Milvus collection name for emails.
        """
        model_name = state.raw_data.get('model_name', 'all-MiniLM-L6-v2')
        safe_model_name = model_name.replace('-', '_')
        return f"{state.customer_id}_email_{safe_model_name}"

    def get_collection_schema(self) -> Any:
        """
        Get the Milvus schema definition for email type.
        """
        try:
            from pymilvus import MilvusClient, DataType
        except ImportError:
            import sys, os
            sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            from pymilvus import MilvusClient, DataType

        schema = MilvusClient.create_schema(auto_id=False, enable_dynamic_field=True)
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
        index_params.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")

        return schema, index_params
