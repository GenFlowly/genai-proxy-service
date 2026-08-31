import json
import logging
from typing import Dict, Any, Tuple, List
from .data_processor import DataProcessor
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState

try:
    from models.encoding.memory_model import MemoryModel
except ImportError:
    import sys, os
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models.encoding.memory_model import MemoryModel

logger = logging.getLogger()


class MemoryProcessor(DataProcessor):
    """
    Processor for long-term user memories extracted by the proxy from
    conversations and notes.

    The vector schema deliberately mirrors NoteProcessor's field names
    (note_value/title/client/created_at) so retrieval's fixed output_fields
    list surfaces memory hits without any retrieval-server change; memory_key
    replaces note_key as the deletion handle.
    """

    def validate(self, state: MemoryRequestInternalState) -> bool:
        """
        Validate that the state contains valid memory data.
        """
        required_fields = ['memory_key', 'memory_value']
        missing_fields = [
            f for f in required_fields
            if f not in state.raw_data and _camel(f) not in state.raw_data
        ]

        if missing_fields:
            raise ValueError(f"Missing required memory fields: {missing_fields}")

        try:
            memory_model = MemoryModel.from_dict(state.raw_data)
            logger.info(f"Validated MemoryModel for memory_key: {memory_model.memory_key}")
        except Exception as e:
            raise ValueError(f"Invalid MemoryModel data: {str(e)}")

        return True

    def to_sqs_message(self, state: MemoryRequestInternalState) -> Tuple[str, Dict[str, Any]]:
        """
        Convert memory state to SQS message format.
        """
        memory_model = MemoryModel.from_dict(state.raw_data)
        state.raw_data = memory_model.to_dict()

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
        Prepare memory data for insertion into Zilliz/Milvus.
        Memories are short; chunking normally yields a single record.
        """
        memory_model = MemoryModel.from_dict(state.raw_data)

        records = []
        for i, chunk_data in enumerate(embeddings):
            record = {
                "id": f"{memory_model.memory_key}_{i}",
                "vector": chunk_data['vector'],
                "note_value": chunk_data['text'][:65535],
                "title": (memory_model.title or "")[:500],
                "memory_key": (memory_model.memory_key or "")[:256],
                "client": state.client[:100],
                "created_at": memory_model.created_at,
            }
            records.append(record)

        return records

    def get_text_to_encode(self, state: MemoryRequestInternalState) -> str:
        """
        Extract the raw text string for a memory.
        """
        memory = MemoryModel.from_dict(state.raw_data)
        return memory.memory_value

    def get_collection_name(self, state: MemoryRequestInternalState) -> str:
        model_name = state.model_name or 'all-MiniLM-L6-v2'
        safe_model_name = model_name.replace('-', '_')
        return f"{state.customer_id}_memory_{safe_model_name}"

    def get_collection_schema(self, dim: int = 384, description: str = "") -> Any:
        """
        Get the Milvus schema definition for memory type.
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
        schema.add_field(field_name="memory_key", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="client", datatype=DataType.VARCHAR, max_length=100)
        schema.add_field(field_name="created_at", datatype=DataType.VARCHAR, max_length=64)

        index_params = MilvusClient.prepare_index_params()
        index_params.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")

        return schema, index_params


def _camel(snake: str) -> str:
    parts = snake.split('_')
    return parts[0] + ''.join(word.capitalize() for word in parts[1:])
