import os
import sys
import json
from unittest.mock import patch, MagicMock

# Add encoding-library and handlers to path for testing
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.insert(0, parent_dir)
sys.path.insert(0, os.path.abspath(os.path.join(parent_dir, '../encoding-library/src')))

# Force region to avoid boto3 init errors
os.environ['AWS_REGION'] = 'us-east-1'

from handlers.store_embeddings_lambda import handler
from pymilvus import DataType

@patch('handlers.store_embeddings_lambda.MilvusClient')
@patch('handlers.store_embeddings_lambda.get_zilliz_credentials')
def test_store_embeddings(mock_get_zilliz, mock_milvus_class):
    
    # 1. Setup networking mocks to avoid burning real AWS/Zilliz credentials
    mock_get_zilliz.return_value = ("https://mock.zilliz.endpoint", "mock-token-1234")
    
    mock_client_instance = MagicMock()
    # Pretend the user's collection does NOT exist yet, forcing the Lambda to generate it dynamically!
    mock_client_instance.has_collection.return_value = False 
    mock_client_instance.insert.return_value = {'insert_count': 3}
    
    mock_milvus_class.return_value = mock_client_instance

    # 2. Construct exactly what `encode_lambda.py` emits to the Step Function!
    event = {
        "data_type": "NOTE",
        "customer_id": "mock-customer-123",
        "client": "local-test-script",
        "raw_data": {
            "note_value": "Here is our test note that has been completely processed.",
            "title": "Zilliz Storage Test Note",
            "created_at": "2026-03-28T12:00:00Z",
            "note_key": "optional-external-key-123"
        },
        "data_embeddings": [
            {"vector": [0.1] * 384, "text": "chunk 1", "index": 0},
            {"vector": [0.2] * 384, "text": "chunk 2", "index": 1},
            {"vector": [0.3] * 384, "text": "chunk 3", "index": 2}
        ]
    }

    # Dummy context
    context = {}

    print("Sending mocked payload to store_embeddings_lambda handler...")
    print(json.dumps(event, indent=2))
    print("-" * 50)

    try:
        # 3. Invoke the lambda handler
        response = handler(event, context)
        
        # 4. Print what the Lambda returns
        print("\nSUCCESS! Lambda Response:")
        print(json.dumps(response, indent=2))
        
        # 5. Verify the Dynamic Collection & Schema Generation
        print("\n" + "=" * 50)
        print("MILVUS INTEGRATION VERIFICATION:")
        print("=" * 50)
        
        if mock_client_instance.create_collection.called:
            call_kwargs = mock_client_instance.create_collection.call_args[1]
            collection_name = call_kwargs.get('collection_name')
            
            print(f"\n>> Dynamically created Collection: '{collection_name}'")
            print(">> Schema fields configured:")
            
            schema = call_kwargs.get('schema')
            for field in schema.fields:
                print(f"  - {field.name} ({field.dtype})")
        else:
            print("\nWARNING: create_collection was NOT called!")

        # 6. Verify the Insertion
        if mock_client_instance.insert.called:
            call_kwargs = mock_client_instance.insert.call_args[1]
            data_inserted = call_kwargs.get('data')
            
            print(f"\n>> Successfully inserted {len(data_inserted)} records into Zilliz!")
            print(">> Example of a formatted record sent to cloud:")
            
            # Print just the first record, truncate the vector so it isn't huge
            example_record = dict(data_inserted[0])
            if 'vector' in example_record:
                example_record['vector'] = f"<384 dimension list>"
                
            print(json.dumps(example_record, indent=2))
            
        else:
            print("\nERROR: Zilliz insert was NOT called!")

    except Exception as e:
        import traceback
        print(f"\nFAILED with error:\n{traceback.format_exc()}")

if __name__ == '__main__':
    test_store_embeddings()
