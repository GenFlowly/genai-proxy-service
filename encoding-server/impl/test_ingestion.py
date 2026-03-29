import sys
import os
import json
from unittest.mock import patch, MagicMock

# Add the parent directory to the path so we can import from handlers, models, etc.
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

# Override environment variables before importing anything to avoid boto3 init errors
os.environ['AWS_REGION'] = 'us-east-1'
os.environ['QUEUE_URL'] = 'https://sqs.us-east-1.amazonaws.com/123456789/mock-queue'

from handlers.ingestion_lambda import handler

@patch('handlers.ingestion_lambda.sqs')
@patch('handlers.ingestion_lambda.auth_service')
def test_ingestion(mock_auth_service, mock_sqs):
    # Setup mock Auth Service to bypass actual DynamoDB network lookup
    mock_auth_service.verify_user.return_value = (True, "mocked-customer-id-123", None)
    
    # Setup mock SQS to return a fake message ID without doing a real network call
    mock_sqs.send_message.return_value = {'MessageId': 'fake-sqs-message-id'}
    
    # Construct a realistic API Gateway HTTP API v2 Event
    event = {
        "requestContext": {
            "authorizer": {
                "jwt": {
                    "claims": {
                        "sub": "auth0|local-test-user"
                    }
                }
            }
        },
        "body": json.dumps({
            "dataType": "NOTE",
            "client": "local-test-script",
            "data": {
                "note_value": "This represents the raw string text that a user typed into the frontend app.",
                "title": "Local Test Note",
                "created_at": "2026-03-28T12:00:00Z",
                "model_type": "SENTENCE_TRANSFORMER",    # Utilizing our new dynamic parameter!
                "chunking_type": "SEMANTIC"              # Utilizing our new dynamic parameter!
            }
        })
    }

    # Dummy context container
    context = {}

    print("Sending mocked API Gateway event to ingestion_lambda handler...")
    print(json.dumps(event, indent=2))
    print("-" * 50)

    try:
        # 1. Invoke the lambda handler
        response = handler(event, context)
        
        # 2. Print what the Lambda returns to API Gateway
        print("\nSUCCESS! Lambda Response (Status 202 expected):")
        print(json.dumps(response, indent=2))
        
        # 3. Print exactly what got forwarded to SQS
        print("\n" + "=" * 50)
        print("SQS PAYLOAD VERIFICATION:")
        print("=" * 50)
        
        if mock_sqs.send_message.called:
            call_kwargs = mock_sqs.send_message.call_args[1]
            
            print("\n>> Message Attributes (Used for Routing/Filtering):")
            print(json.dumps(call_kwargs.get('MessageAttributes'), indent=2))
            
            print("\n>> Message Body (The serialized MemoryRequestInternalState):")
            # Parse the JSON string body back to dict for pretty printing
            body_json = json.loads(call_kwargs.get('MessageBody'))
            print(json.dumps(body_json, indent=2))
        else:
            print("ERROR: SQS send_message was never called!")

    except Exception as e:
        import traceback
        print(f"\nFAILED with error:\n{traceback.format_exc()}")

if __name__ == "__main__":
    test_ingestion()
