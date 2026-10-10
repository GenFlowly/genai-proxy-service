import os
import json
import logging
from typing import Dict, Any

from encoding_library.chunkers.enums import ChunkingType
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.observability import set_request_id, setup_logging, track
from encoding_library.utils.embedding_utils import create_chunks, get_embedding_model
from encoding_library.utils.model_registry import get_chunking_params

from services.content_logging import default_log_level

setup_logging("encoding-server", level=default_log_level())
logger = logging.getLogger()

BATCH_SIZE = int(os.environ.get('BATCH_SIZE', 25))


@track("parse_and_chunk")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Parse and Chunk Lambda — first node in the Step Functions V2 pipeline.
    Receives a MemoryRequestInternalState, chunks the text, and returns
    a { "batches": [...] } payload for the downstream Map state.
    """
    try:
        logger.info(f"Received parse-and-chunk request.")

        memory_request_internal_state = MemoryRequestInternalState.from_dict(event)
        set_request_id(memory_request_internal_state.request_id)

        processor = ProcessorFactory.get_processor(memory_request_internal_state)
        text_to_encode = processor.get_text_to_encode(memory_request_internal_state)

        # Only semantic chunking needs the embedding model; recursive chunking
        # should not pay the model load (or require API keys) here.
        chunking_type = memory_request_internal_state.chunking_type or ChunkingType.RECURSIVE.value
        encoder = None
        if chunking_type == ChunkingType.SEMANTIC.value:
            encoder = get_embedding_model(
                memory_request_internal_state.model_type,
                memory_request_internal_state.model_name,
            )
        # Request overrides win; otherwise per-model values from the
        # EmbeddingModelRegistry table (falling back to code defaults)
        chunk_size, chunk_overlap = get_chunking_params(
            memory_request_internal_state.model_type,
            memory_request_internal_state.model_name,
            memory_request_internal_state.chunk_size,
            memory_request_internal_state.chunk_overlap,
        )
        chunks = create_chunks(
            text_to_encode,
            encoder,
            chunking_type=chunking_type,
            chunking_technique=memory_request_internal_state.chunking_technique,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )

        logger.info(f"Chunked into {len(chunks)} pieces across batch_size={BATCH_SIZE}.")

        # Strip the heavy text fields after chunking — the full document text is
        # no longer needed downstream and would otherwise blow the 256KB Step
        # Functions payload limit. The record keys/metadata (note_key,
        # memory_key, conversation_key, ...) must survive into every batch:
        # the store step derives vector ids and delete-by-filter handles from them.
        retained_raw_data = processor.get_retained_raw_data(memory_request_internal_state)
        memory_request_internal_state.raw_data = retained_raw_data

        batches = []
        for i in range(0, len(chunks), BATCH_SIZE):
            batch_state = MemoryRequestInternalState(
                data_type=memory_request_internal_state.data_type,
                customer_id=memory_request_internal_state.customer_id,
                client=memory_request_internal_state.client,
                raw_data=retained_raw_data,
                model_type=memory_request_internal_state.model_type,
                model_name=memory_request_internal_state.model_name,
                chunking_type=memory_request_internal_state.chunking_type,
                chunking_technique=memory_request_internal_state.chunking_technique,
                data_chunks=chunks[i:i + BATCH_SIZE],
                request_id=memory_request_internal_state.request_id,
            )
            batches.append(batch_state.to_dict())

        logger.info(f"Returning {len(batches)} batches.")
        return {"batches": batches}

    except Exception as e:
        logger.error(f"Error in parse_and_chunk_lambda: {str(e)}")
        raise
