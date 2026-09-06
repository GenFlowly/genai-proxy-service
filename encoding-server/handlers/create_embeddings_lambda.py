import json
import logging
from typing import Dict, Any

from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.observability import count, set_request_id, setup_logging, track
from encoding_library.utils.embedding_utils import create_embeddings, get_embedding_model

setup_logging("encoding-server")
logger = logging.getLogger()
logger.setLevel(logging.INFO)


@track("create_embeddings")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Lambda handler for generating vector embeddings natively from pre-chunked batches.
    Receives an isolated MemoryRequestInternalState batch payload securely mapped from the Step Functions Map State.
    """
    try:
        logger.info(f"Received embed request isolated batch computationally mapped natively.")
        
        # Deserialize batch systematically into standard state representation
        memory_request_internal_state = MemoryRequestInternalState.from_dict(event)
        set_request_id(memory_request_internal_state.request_id)
        
        chunks = memory_request_internal_state.data_chunks
        if not chunks:
            logger.warning("No data_chunks found securely natively in batch payload. Skipping.")
            return event
        

        encoder = get_embedding_model(
            memory_request_internal_state.model_type,
            memory_request_internal_state.model_name,
        )
        
        # Generate mathematical vector array dynamically computationally over text sequences
        logger.info(f"Generating semantic vectors securely for {len(chunks)} iterations natively...")
        embeddings = create_embeddings(chunks, encoder)
        count("embedding_chunks_total", len(embeddings))

        # Clear heavy fields after insertion to avoid Step Functions 256KB payload limit
        memory_request_internal_state.data_chunks = []

        memory_request_internal_state.vectors = embeddings
        return memory_request_internal_state.to_dict()
        
    except Exception as e:
        logger.error(f"Error explicitly executing vector embeddings computationally natively on batch payload: {str(e)}")
        raise
