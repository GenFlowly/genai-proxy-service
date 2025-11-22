import os
from pymilvus import MilvusClient, DataType

# Configuration - Replace with your actual values or set env vars
ZILLIZ_ENDPOINT = os.environ.get('ZILLIZ_ENDPOINT', 'https://in03-0e3d96c83ea3190.serverless.aws-eu-central-1.cloud.zilliz.com')
ZILLIZ_TOKEN = os.environ.get('ZILLIZ_TOKEN', '***REDACTED***')
COLLECTION_NAME = os.environ.get('COLLECTION_NAME', 'test')

def setup_collection():
    print(f"Connecting to Zilliz: {ZILLIZ_ENDPOINT}")
    client = MilvusClient(uri=ZILLIZ_ENDPOINT, token=ZILLIZ_TOKEN)

    # Check if collection exists
    if client.has_collection(COLLECTION_NAME):
        print(f"Collection '{COLLECTION_NAME}' already exists. Dropping it to recreate with correct schema...")
        client.drop_collection(COLLECTION_NAME)
        print("Collection dropped.")

    # Define schema
    schema = client.create_schema(
        auto_id=False,
        enable_dynamic_field=True,
    )

    # Add fields
    # Primary key: email message_id (string)
    schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=256, is_primary=True)
    
    # Vector field (768 dimensions for all-MiniLM-L6-v2 via pymilvus DefaultEmbeddingFunction)
    schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=768)
    
    # Metadata fields
    schema.add_field(field_name="subject", datatype=DataType.VARCHAR, max_length=1024)
    schema.add_field(field_name="from_email", datatype=DataType.VARCHAR, max_length=256)
    schema.add_field(field_name="to_email", datatype=DataType.VARCHAR, max_length=1024)
    schema.add_field(field_name="date", datatype=DataType.VARCHAR, max_length=64)
    schema.add_field(field_name="folder", datatype=DataType.VARCHAR, max_length=128)
    schema.add_field(field_name="thread_id", datatype=DataType.VARCHAR, max_length=256)
    schema.add_field(field_name="in_reply_to", datatype=DataType.VARCHAR, max_length=256)
    schema.add_field(field_name="s3_key", datatype=DataType.VARCHAR, max_length=512)

    # Create collection
    print(f"Creating collection '{COLLECTION_NAME}'...")
    index_params = client.prepare_index_params()
    
    # Add index for vector field
    index_params.add_index(
        field_name="vector", 
        index_type="AUTOINDEX",
        metric_type="COSINE"
    )

    client.create_collection(
        collection_name=COLLECTION_NAME,
        schema=schema,
        index_params=index_params
    )

    print(f"Successfully created collection '{COLLECTION_NAME}' with correct schema!")
    print("Schema details:")
    print(client.describe_collection(COLLECTION_NAME))

if __name__ == "__main__":
    setup_collection()
