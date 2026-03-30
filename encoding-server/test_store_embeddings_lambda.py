import os
import sys
import logging

# Ensure we can import handlers and local modules
sys.path.append(os.path.join(os.path.dirname(__file__), 'handlers'))
# The command line will also inject encoding_library/src to PYTHONPATH

from handlers.store_embeddings_lambda import handler

# Setup standard output logging to explicitly see the trace logs
logging.basicConfig(level=logging.INFO, stream=sys.stdout)

def run_test():
    print("----- STARTING LOCAL TEST -----")
    
    # Needs to match the MemoryRequestInternalState layout expected by store_embeddings_lambda
    test_event = {
        "customer_id": "test-customer-123",
        "raw_data": {
            "title": "Test Document",
            "content": "This is a test document to ensure milvus works.",
            "source": "local_test"
        },
        "data_type": "email",
        "client": "local",
        "data_embeddings": [
            {
                "chunk_id": "chunk-1",
                "embedding": [0.1] * 768, # dummy 768-d embedding
                "text": "This is a test document to ensure milvus works."
            }
        ],
        "message_id": "test-message-123"
    }

    try:
        # Pass empty dict for Lambda context
        result = handler(test_event, {})
        print("----- TEST COMPLETED SUCCESSFULLY -----")
        print("Result:", result)
    except Exception as e:
        print("----- TEST FAILED -----")
        print("Exception:", str(e))

if __name__ == "__main__":
    run_test()
