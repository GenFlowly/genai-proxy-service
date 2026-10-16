import json
import logging
from typing import Dict, Any, Tuple, List
from .data_processor import DataProcessor
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.utils.vector_db import (
    CUSTOMER_ID_MAX_LENGTH,
    add_customer_id_field,
    shared_collection_name,
)

try:
    from models.encoding.instruction_model import InstructionModel
except ImportError:
    import sys, os
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models.encoding.instruction_model import InstructionModel

logger = logging.getLogger()


class InstructionProcessor(DataProcessor):
    """
    Processor for saved instructions (system prompts).

    The vector schema mirrors NoteProcessor's field names
    (note_value/title/client/created_at) so unified search surfaces
    instruction hits without retrieval-server schema changes; instruction_key
    is the grouping/deletion handle. Only the latest version is indexed — the
    store step deletes prior chunks for the instruction before inserting.
    """

    HEAVY_RAW_FIELDS = frozenset({'instructions'})

    def validate(self, state: MemoryRequestInternalState) -> bool:
        """
        Validate that the state contains valid instruction data.
        """
        data = state.raw_data
        if not (data.get('instruction_id') or data.get('instructionId')):
            raise ValueError("Missing required instruction field: instruction_id")
        if not data.get('instructions'):
            raise ValueError("Missing required instruction field: instructions")

        try:
            instruction_model = InstructionModel.from_dict(data)
            logger.info(f"Validated InstructionModel for instruction_id: {instruction_model.instruction_id}")
        except Exception as e:
            raise ValueError(f"Invalid InstructionModel data: {str(e)}")

        return True

    def to_sqs_message(self, state: MemoryRequestInternalState) -> Tuple[str, Dict[str, Any]]:
        """
        Convert instruction state to SQS message format.
        """
        instruction_model = InstructionModel.from_dict(state.raw_data)
        state.raw_data = instruction_model.to_dict()

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
        Prepare instruction data for insertion into Zilliz/Milvus.
        Returns one record per chunk.
        """
        instruction_model = InstructionModel.from_dict(state.raw_data)

        records = []
        for i, chunk_data in enumerate(embeddings):
            record = {
                "id": f"{instruction_model.instruction_id}_{i}",
                "customer_id": state.customer_id[:CUSTOMER_ID_MAX_LENGTH],
                "vector": chunk_data['vector'],
                "note_value": chunk_data['text'][:65535],
                "title": (instruction_model.name or "")[:500],
                "instruction_key": instruction_model.instruction_id[:256],
                "version": instruction_model.version,
                "category": (instruction_model.category or "")[:256],
                "client": state.client[:100],
                "created_at": instruction_model.created_at,
            }
            records.append(record)

        return records

    def get_text_to_encode(self, state: MemoryRequestInternalState) -> str:
        """
        Extract the raw text string for an instruction. Name, category and
        tags are prepended so they contribute to semantic matching.
        """
        instruction = InstructionModel.from_dict(state.raw_data)
        header_parts = [instruction.name or ""]
        if instruction.category:
            header_parts.append(instruction.category)
        if instruction.tags:
            header_parts.append(", ".join(instruction.tags))
        header = "\n".join(p for p in header_parts if p)
        return f"{header}\n\n{instruction.instructions}" if header else instruction.instructions

    def get_collection_name(self, state: MemoryRequestInternalState) -> str:
        return shared_collection_name("instructions", state.model_name)

    def get_collection_schema(self, dim: int = 384, description: str = "") -> Any:
        """
        Get the Milvus schema definition for instruction type.
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
        schema.add_field(field_name="instruction_key", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="version", datatype=DataType.INT64)
        schema.add_field(field_name="category", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="client", datatype=DataType.VARCHAR, max_length=100)
        schema.add_field(field_name="created_at", datatype=DataType.VARCHAR, max_length=64)
        add_customer_id_field(schema)

        index_params = MilvusClient.prepare_index_params()
        index_params.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")

        return schema, index_params
