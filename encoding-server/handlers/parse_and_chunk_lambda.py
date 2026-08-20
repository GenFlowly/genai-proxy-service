import os
import json
import logging
from typing import Dict, Any

from encoding_library.chunkers.enums import ChunkingType
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.utils.embedding_utils import create_chunks, get_embedding_model

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BATCH_SIZE = int(os.environ.get('BATCH_SIZE', 25))


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Parse and Chunk Lambda — first node in the Step Functions V2 pipeline.
    Receives a MemoryRequestInternalState, chunks the text, and returns
    a { "batches": [...] } payload for the downstream Map state.
    """
    try:
        logger.info(f"Received parse-and-chunk request.")

        memory_request_internal_state = MemoryRequestInternalState.from_dict(event)

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
        chunks = create_chunks(
            text_to_encode,
            encoder,
            chunking_type=chunking_type,
            chunking_technique=memory_request_internal_state.chunking_technique,
        )

        logger.info(f"Chunked into {len(chunks)} pieces across batch_size={BATCH_SIZE}.")

        # Clear raw_data after chunking — the full document text is no longer needed
        # downstream and would otherwise blow the 256KB Step Functions payload limit.
        memory_request_internal_state.raw_data = {}

        batches = []
        for i in range(0, len(chunks), BATCH_SIZE):
            batch_state = MemoryRequestInternalState(
                data_type=memory_request_internal_state.data_type,
                customer_id=memory_request_internal_state.customer_id,
                client=memory_request_internal_state.client,
                raw_data={},
                model_type=memory_request_internal_state.model_type,
                model_name=memory_request_internal_state.model_name,
                chunking_type=memory_request_internal_state.chunking_type,
                chunking_technique=memory_request_internal_state.chunking_technique,
                data_chunks=chunks[i:i + BATCH_SIZE],
                processing_mode=memory_request_internal_state.processing_mode,
            )
            batches.append(batch_state.to_dict())

        # Surface processing_mode at the top level so the Step Functions Choice
        # state can route between the realtime Map and the Voyage batch branch.
        # Batch mode is voyage-only; anything else falls back to realtime.
        processing_mode = (memory_request_internal_state.processing_mode or "realtime").lower()
        if processing_mode == "batch" and (memory_request_internal_state.model_type or "") != "voyage":
            logger.warning(
                "processing_mode=batch is only supported for model_type=voyage; "
                "falling back to realtime."
            )
            processing_mode = "realtime"

        logger.info(f"Returning {len(batches)} batches (processing_mode={processing_mode}).")
        return {"batches": batches, "processing_mode": processing_mode}

    except Exception as e:
        logger.error(f"Error in parse_and_chunk_lambda: {str(e)}")
        raise
