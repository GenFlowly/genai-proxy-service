import os
import sys

# Add encoding-library to path for testing
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../encoding-library/src')))

# Force region and table
os.environ['AWS_REGION'] = 'us-east-1'
os.environ['CUSTOMER_VECTOR_DB_CONFIG_TABLE'] = 'CustomerVectorDBConfig'

from encoding_library.utils.vector_db import get_zilliz_credentials

def main():
    customer_id = 'CU1C040186FF2F'
    print(f"Testing credential fetch for {customer_id}")
    try:
        endpoint, token = get_zilliz_credentials(customer_id)
        print(f"Successfully fetched credentials!")
        print(f"Endpoint: {endpoint}")
        # Mask the token for safety, but show length to confirm it decrypted something
        print(f"Token length: {len(token) if token else 0}")
        print(f"Token start: {token[:10] if token else ''}...")
        
        from pymilvus import MilvusClient
        print("Connecting to Milvus...")
        client = MilvusClient(uri=endpoint, token=token)
        print("Successfully connected! Collections:")
        print(client.list_collections())
        
    except Exception as e:
        print(f"Failed to fetch credentials: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    main()
