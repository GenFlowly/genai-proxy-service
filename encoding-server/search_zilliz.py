import os
import sys
from pymilvus import MilvusClient, model

# Configuration
ZILLIZ_ENDPOINT = os.environ.get('ZILLIZ_ENDPOINT', 'https://in03-0e3d96c83ea3190.serverless.aws-eu-central-1.cloud.zilliz.com')
ZILLIZ_TOKEN = os.environ.get('ZILLIZ_TOKEN', '***REDACTED***')
COLLECTION_NAME = os.environ.get('COLLECTION_NAME', 'test')

def search_emails(query_text, limit=5):
    print(f"Connecting to Zilliz: {ZILLIZ_ENDPOINT}")
    client = MilvusClient(uri=ZILLIZ_ENDPOINT, token=ZILLIZ_TOKEN)

    print("Loading embedding model...")
    # Use the same model as the ingestion lambda
    embedding_fn = model.DefaultEmbeddingFunction()
    
    print(f"Generating embedding for query: '{query_text}'")
    query_vectors = embedding_fn.encode_queries([query_text])

    print(f"Searching collection '{COLLECTION_NAME}'...")
    results = client.search(
        collection_name=COLLECTION_NAME,
        data=query_vectors,
        limit=limit,
        output_fields=["subject", "from_email", "date", "folder", "s3_key"]
    )

    print("\n" + "="*80)
    print(f"SEARCH RESULTS FOR: '{query_text}'")
    print("="*80)
    
    for result in results[0]:
        entity = result['entity']
        print(f"Score: {result['distance']:.4f}")
        print(f"Subject: {entity.get('subject', 'N/A')}")
        print(f"From: {entity.get('from_email', 'N/A')}")
        print(f"Date: {entity.get('date', 'N/A')}")
        print(f"Folder: {entity.get('folder', 'N/A')}")
        print(f"ID: {result['id']}")
        print("-" * 40)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        query = " ".join(sys.argv[1:])
    else:
        query = input("Enter search query: ")
    
    if query:
        search_emails(query)
    else:
        print("No query provided.")
