import json
import logging
from typing import Dict, Any, Tuple, List
from .data_processor import DataProcessor
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState

try:
    from models.encoding.conversation_model import ConversationModel
except ImportError:
    import sys, os
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models.encoding.conversation_model import ConversationModel

logger = logging.getLogger()


class ConversationProcessor(DataProcessor):
    """
    Processor for conversation exchanges pushed by the proxy after each
    completed user/assistant turn.

    The vector schema mirrors NoteProcessor's field names
    (note_value/title/client/created_at) — same convention as MemoryProcessor —
    so any consumer with the fixed notes output_fields list can surface hits;
    conversation_key/message_key are the grouping and deletion handles.
    """

    HEAVY_RAW_FIELDS = frozenset({'text'})

    def validate(self, state: MemoryRequestInternalState) -> bool:
        """
        Validate that the state contains valid conversation-exchange data.
        """
        required_fields = ['conversation_key', 'message_key', 'text']
        missing_fields = [
            f for f in required_fields
            if f not in state.raw_data and _camel(f) not in state.raw_data
        ]

        if missing_fields:
            raise ValueError(f"Missing required conversation fields: {missing_fields}")

        try:
            conversation_model = ConversationModel.from_dict(state.raw_data)
            logger.info(f"Validated ConversationModel for message_key: {conversation_model.message_key}")
        except Exception as e:
            raise ValueError(f"Invalid ConversationModel data: {str(e)}")

        return True

    def to_sqs_message(self, state: MemoryRequestInternalState) -> Tuple[str, Dict[str, Any]]:
        """
        Convert conversation state to SQS message format.
        """
        conversation_model = ConversationModel.from_dict(state.raw_data)
        state.raw_data = conversation_model.to_dict()

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
        Prepare conversation data for insertion into Zilliz/Milvus.
        Returns one record per chunk, keyed by the exchange's message_key.
        """
        conversation_model = ConversationModel.from_dict(state.raw_data)

        records = []
        for i, chunk_data in enumerate(embeddings):
            record = {
                "id": f"{conversation_model.message_key}_{i}",
                "vector": chunk_data['vector'],
                "note_value": chunk_data['text'][:65535],
                "title": (conversation_model.title or "")[:500],
                "conversation_key": (conversation_model.conversation_key or "")[:256],
                "message_key": (conversation_model.message_key or "")[:256],
                "client": state.client[:100],
                "created_at": conversation_model.created_at,
            }
            records.append(record)

        return records

    def get_text_to_encode(self, state: MemoryRequestInternalState) -> str:
        """
        Extract the raw exchange text ("User: ...\nAssistant: ...").
        """
        conversation = ConversationModel.from_dict(state.raw_data)
        return conversation.text

    def get_collection_name(self, state: MemoryRequestInternalState) -> str:
        model_name = state.model_name or 'all-MiniLM-L6-v2'
        safe_model_name = model_name.replace('-', '_')
        return f"{state.customer_id}_conversation_{safe_model_name}"

    def get_collection_schema(self, dim: int = 384, description: str = "") -> Any:
        """
        Get the Milvus schema definition for conversation type.
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
        schema.add_field(field_name="conversation_key", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="message_key", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="client", datatype=DataType.VARCHAR, max_length=100)
        schema.add_field(field_name="created_at", datatype=DataType.VARCHAR, max_length=64)

        index_params = MilvusClient.prepare_index_params()
        index_params.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")

        return schema, index_params


def _camel(snake: str) -> str:
    parts = snake.split('_')
    return parts[0] + ''.join(word.capitalize() for word in parts[1:])
