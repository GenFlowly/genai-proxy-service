import json
import logging
from typing import Dict, Any

from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.utils.embedding_utils import create_chunks, get_embedding_model

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Lambda handler for parsing and chunking text payload.
    Receives a MemoryRequestInternalState dict from the Step Function triggers, 
    breaks down the text_to_encode into discrete chunks, and attaches them to state.
    """
    try:
        logger.info(f"Received parsing request: {json.dumps(event)}")
        
        # Deserialize standard internal state
        internal_state = MemoryRequestInternalState.from_dict(event)
        
        # Construct proxy dict for legacy extraction compatibility
        data = internal_state.raw_data.copy()
        data['dataType'] = internal_state.data_type
        
        # Instantiate Processor based on strict Data Type parsing logic
        processor = ProcessorFactory.get_processor(data)
        text_to_encode = processor.get_text_to_encode(data)
        
        # Read the native model metadata embedded by the user
        model_type_str = data.get('model_type', "sentence-transformer")
        model_name_str = data.get('model_name', "all-MiniLM-L6-v2") 
        
        # Extract native Langchain embedding instantiation
        encoder = get_embedding_model(model_type_str, model_name_str)
        
        # Execute Semantic/Recursive chunking logic natively
        chunks = create_chunks(data, text_to_encode, encoder)
        
        logger.info(f"Successfully chunked payload into {len(chunks)} pieces.")
        
        # Deposit chunk array directly into shared state pipeline memory
        internal_state.data_chunks = chunks
        
        # Output exactly the serialized state payload mapped for the subsequent EncodeLambda task
        return internal_state.to_dict()
        
    except Exception as e:
        logger.error(f"Error parsing and chunking inbound text payload: {str(e)}")
        raise
