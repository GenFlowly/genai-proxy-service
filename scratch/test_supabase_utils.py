import sys
from unittest.mock import MagicMock, patch

# Mock all external dependencies
symbols = [
    'boto3', 'supabase', 'psycopg2', 
    'langchain_text_splitters', 'langchain_experimental',
    'langchain_huggingface', 'langchain_openai', 'langchain_core',
    'tiktoken', 'pydantic'
]
for symbol in symbols:
    sys.modules[symbol] = MagicMock()

import os
import base64

# Add the src directory to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../encoding-library/src')))

from encoding_library import supabase

def test_supabase_utils():
    customer_id = "test-customer"
    schema = "CREATE TABLE test (id INT);"
    
    # Mock DynamoDB
    mock_table = MagicMock()
    supabase.supabase_config_table = mock_table
    
    # Encrypted mock data
    mock_item = {
        'endpoint': base64.b64encode(b"https://ref123.supabase.co").decode('utf-8'),
        'token': base64.b64encode(b"mock-token").decode('utf-8'),
        'password': base64.b64encode(b"mock-password").decode('utf-8')
    }
    mock_table.get_item.return_value = {'Item': mock_item}
    
    # Mock KMS
    mock_kms = MagicMock()
    supabase.kms_client = mock_kms
    
    def side_effect(CiphertextBlob=None):
        return {'Plaintext': CiphertextBlob}  # Just return the blob as is for test
        
    mock_kms.decrypt.side_effect = side_effect
    
    print("Testing get_supabase_credentials...")
    endpoint, token, password = supabase.get_supabase_credentials(customer_id)
    assert endpoint == "https://ref123.supabase.co"
    assert token == "mock-token"
    assert password == "mock-password"
    print("Success!")
    
    print("Testing get_supabase_client...")
    with patch('encoding_library.utils.supabase_utils.create_client') as mock_create:
        supabase.get_supabase_client(customer_id)
        mock_create.assert_called_once_with("https://ref123.supabase.co", "mock-token")
    print("Success!")
    
    print("Testing create_table (with fallback logic)...")
    with patch('psycopg2.connect') as mock_connect:
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value = mock_cur
        
        # Scenario: First attempt (direct) fails, second (pooler) succeeds
        mock_connect.side_effect = [
            Exception("Direct host resolution failed (IPv6 issue)"),
            mock_conn, # Second call succeeds
            mock_conn  # Third call (if it needed it)
        ]
        
        supabase.create_table(customer_id, schema)
        
        # Verify it was called twice
        assert mock_connect.call_count == 2
        
        # Check first call args
        first_call = mock_connect.call_args_list[0]
        assert first_call.kwargs['host'] == "db.ref123.supabase.co"
        assert first_call.kwargs['port'] == 5432
        
        # Check second call args (the successful fallback)
        second_call = mock_connect.call_args_list[1]
        assert second_call.kwargs['host'] == "ref123.supabase.co"
        assert second_call.kwargs['port'] == 6543
        
        mock_cur.execute.assert_called_once_with(schema)
        mock_conn.commit.assert_called_once()
    print("Success!")

    print("Testing CRUD methods...")
    # Since supabase.get_supabase_client was patched in its own test, 
    # we patch it here specifically for the CRUD test logic
    with patch('encoding_library.supabase.get_supabase_client') as mock_get_client:
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client
        mock_table = MagicMock()
        mock_client.table.return_value = mock_table
        
        # Test insert_data
        data = {"name": "test"}
        supabase.insert_data(customer_id, "my_table", data)
        mock_table.insert.assert_called_once_with(data)
        
        # Test update_data
        filters = {"id": 1}
        supabase.update_data(customer_id, "my_table", data, filters)
        mock_table.update.assert_called_once_with(data)
        mock_table.update.return_value.eq.assert_called_once_with("id", 1)
        
        # Test fetch_data
        supabase.fetch_data(customer_id, "my_table", filters)
        mock_table.select.assert_called_once_with("*")
        mock_table.select.return_value.eq.assert_called_once_with("id", 1)
        
    print("CRUD Methods Success!")

if __name__ == "__main__":
    try:
        test_supabase_utils()
        print("\nAll tests passed!")
    except Exception as e:
        print(f"\nTest failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
