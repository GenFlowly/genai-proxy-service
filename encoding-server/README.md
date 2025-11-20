# Encoding Server

Python-based serverless email encoding service using AWS Lambda.

## Components

### 1. Ingestion Lambda (`ingestion_lambda.py`)
- Receives email data from API Gateway
- Validates request payload
- Sends to SQS queue for processing
- Returns 202 Accepted response

### 2. Processing Lambda (`processing_lambda.py`)
- Triggered by SQS messages
- Encodes email subject + body using `all-MiniLM-L6-v2` model
- Stores embeddings in Zilliz Cloud
- Backs up raw email to S3

## Setup

### Create virtual environment
```bash
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
```

### Install dependencies
```bash
pip install -r requirements.txt
```

## Testing Locally

### Test Ingestion Lambda
```python
from ingestion_lambda import handler
import json

event = {
    "body": json.dumps({
        "subject": "Test Email",
        "body": "This is a test email body",
        "from": "sender@example.com",
        "to": "recipient@example.com",
        "date": "2024-01-01T00:00:00Z",
        "messageId": "test-123"
    })
}

result = handler(event, None)
print(result)
```

### Test Processing Lambda
```python
from processing_lambda import handler
import json

event = {
    "Records": [{
        "body": json.dumps({
            "subject": "Test Email",
            "body": "This is a test email body",
            "from": "sender@example.com",
            "to": "recipient@example.com",
            "date": "2024-01-01T00:00:00Z",
            "messageId": "test-123"
        })
    }]
}

result = handler(event, None)
print(result)
```

## Deployment

The Lambda functions are deployed via CDK in the `genai-proxy-server-cdk` directory.

### Build Docker image for Processing Lambda
```bash
docker build -t encoding-service-processing .
```

## Environment Variables

### Ingestion Lambda
- `QUEUE_URL` - SQS queue URL

### Processing Lambda
- `BUCKET_NAME` - S3 bucket for email backups
- `ZILLIZ_ENDPOINT` - Zilliz Cloud endpoint
- `ZILLIZ_TOKEN` - Zilliz Cloud authentication token
- `COLLECTION_NAME` - Milvus collection name (default: 'test')

## Architecture

```
API Gateway → Ingestion Lambda → SQS → Processing Lambda → Zilliz Cloud
                                                        ↓
                                                       S3
```
