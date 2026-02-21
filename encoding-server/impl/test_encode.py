import sys
import os
import json

# Add the parent directory to the path so we can import from handlers, models, etc.
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

from handlers.encode_lambda import handler

def test_encode_note():
    # Construct a dummy Note payload event
    # Similar to what the API Gateway or SQS would trigger
    event = {
        "customer_id": "test-customer-123",
        "data": {
            "note_value": "This is a test note. It contains multiple sentences. We want to see how the chunker handles it and how the encoder embeds it! The refactor should have fixed the circular import perfectly.",
            "client": "test-client",
            "created_at": "2026-02-21T12:00:00Z",
            "title": "My Refactor Test Note",
            "chunking_type": "semantic" # Explicitly request semantic chunking to test the refactored code path
        }
    }

    # Dummy context (not used by lambda currently, but required by signature)
    context = {}

    print("Sending event to encode_lambda.py handler...")
    print(json.dumps(event, indent=2))
    print("-" * 50)

    try:
        # Invoke the lambda handler
        response = handler(event, context)
        
        print("\nSUCCESS! Received Response:")
        # We don't want to print huge vector numbers to the console, so we'll summarize them
        summary_response = dict(response)
        
        if 'data' in summary_response and 'embeddings' in summary_response['data']:
            embeddings = summary_response['data']['embeddings']
            print(f"Total chunks created: {len(embeddings)}")
            
            for i, chunk in enumerate(embeddings):
                vector_len = len(chunk['vector']) if 'vector' in chunk else 0
                sample = chunk['vector'][:5] if 'vector' in chunk else []
                print(f"  Chunk {i}:")
                print(f"    Text: '{chunk.get('text', '')}'")
                print(f"    Vector Dimension: {vector_len}")
                print(f"    Vector Sample: {sample}...")
                
            # Remove the full embeddings from output so it's readable
            summary_response['data']['embeddings'] = f"<List of {len(embeddings)} chunk dicts omitted for brevity>"
            
        print("\nFull Response Structure:")
        print(json.dumps(summary_response, indent=2))

    except Exception as e:
        import traceback
        print(f"\nFAILED with error:\n{traceback.format_exc()}")

if __name__ == "__main__":
    test_encode_note()
