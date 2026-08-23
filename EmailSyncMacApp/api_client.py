import time
from typing import List
import config

class ApiClient:
    """
    API Client for uploading email data to server.
    Supports batch uploads, authentication, and rate limiting.
    """
    
    # Configuration
    BATCH_SIZE = 500  # Max emails per batch
    MAX_RETRIES = 3
    RATE_LIMIT = 60  # requests per minute
    
    def __init__(self, access_token=None):
        """
        Initialize API client.
        
        Args:
            access_token: Auth0 bearer token for API authentication
        """
        self.api_url = f"{config.API_BASE_URL}{config.API_BATCH_ENDPOINT}"
        self.access_token = access_token
        self.request_count = 0
        self.minute_start = time.time()
        self.total_uploaded = 0
    
    def set_access_token(self, access_token):
        """Update the access token"""
        self.access_token = access_token
    
    def _get_headers(self):
        """Get request headers with authentication"""
        headers = {
            "Content-Type": "application/json"
        }
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        return headers
    
    def _rate_limit(self):
        """Apply rate limiting"""
        current_time = time.time()
        
        # Reset counter every minute
        if current_time - self.minute_start > 60:
            self.request_count = 0
            self.minute_start = current_time
        
        # Check if we've hit the limit
        if self.request_count >= self.RATE_LIMIT:
            sleep_time = 60 - (current_time - self.minute_start)
            if sleep_time > 0:
                time.sleep(sleep_time)
                self.request_count = 0
                self.minute_start = time.time()
        
        self.request_count += 1
    
    def send_batch(self, emails: List, account_id: str = None) -> dict:
        """
        Send a batch of emails to the API.
        
        Args:
            emails: List of EmailModel objects
            account_id: Optional account identifier
            
        Returns:
            dict with keys: success, uploaded, failed, errors
        """
        if not emails:
            return {"success": True, "uploaded": 0, "failed": 0, "errors": []}
        
        try:
            # Apply rate limiting
            self._rate_limit()
            
            # Make actual HTTP request
            import requests
            import json
            headers = self._get_headers()
            
            # Convert emails to dict format
            emails_data = [email.to_dict() for email in emails]

            # The ingest lambda requires a {client, data} envelope per item and
            # reads the embedding model from top-level modelType/modelName
            payload = [
                {
                    "client": config.API_CLIENT_NAME,
                    "modelType": config.EMBEDDING_MODEL_TYPE,
                    "modelName": config.EMBEDDING_MODEL_NAME,
                    "data": email_data,
                }
                for email_data in emails_data
            ]
            
            auth_status = "with auth" if self.access_token else "no auth"
            
            # Detailed logging
            print("\n" + "="*80)
            print(f"[API] SENDING BATCH REQUEST")
            print("="*80)
            print(f"URL: {self.api_url}")
            print(f"Method: POST")
            print(f"Auth: {auth_status}")
            print(f"Headers: {json.dumps(headers, indent=2)}")
            print(f"Batch size: {len(emails)} emails")
            if emails:
                print(f"First email preview:")
                first_email = emails_data[0]
                print(f"  - Subject: {first_email.get('subject', 'N/A')}")
                print(f"  - From: {first_email.get('from', 'N/A')}")
                print(f"  - Date: {first_email.get('date', 'N/A')}")
                print(f"  - Message ID: {first_email.get('message_id', 'N/A')[:50]}...")
            print(f"Payload preview (first 500 chars): {json.dumps(payload)[:500]}...")
            print("-"*80)
            
            response = requests.post(self.api_url, json=payload, headers=headers, timeout=30)
            
            # Log response details
            print(f"[API] RESPONSE RECEIVED")
            print("-"*80)
            print(f"Status Code: {response.status_code}")
            print(f"Status: {response.reason}")
            print(f"Response Headers: {json.dumps(dict(response.headers), indent=2)}")
            print(f"Response Body: {response.text[:500]}")  # First 500 chars
            print("="*80 + "\n")
            
            response.raise_for_status()  # Raise exception for bad status codes
            
            self.total_uploaded += len(emails)
            
            # Try to parse JSON response, fallback to success if not JSON
            try:
                result = response.json()
                print(f"[API] ✓ Success - Parsed JSON response")
                return result
            except:
                # If response is not JSON, assume success
                print(f"[API] ✓ Success - Non-JSON response (Status {response.status_code})")
                return {
                    "success": True,
                    "uploaded": len(emails),
                    "failed": 0,
                    "duplicates": 0,
                    "errors": []
                }
        except requests.exceptions.RequestException as e:
            print("\n" + "="*80)
            print(f"[API] ✗ REQUEST ERROR")
            print("="*80)
            print(f"Error Type: {type(e).__name__}")
            print(f"Error Message: {str(e)}")
            if hasattr(e, 'response') and e.response is not None:
                print(f"Response Status: {e.response.status_code}")
                print(f"Response Body: {e.response.text}")
            print("="*80 + "\n")
            return {
                "success": False,
                "uploaded": 0,
                "failed": len(emails),
                "errors": [str(e)]
            }
        except Exception as e:
            print("\n" + "="*80)
            print(f"[API] ✗ UNEXPECTED ERROR")
            print("="*80)
            print(f"Error Type: {type(e).__name__}")
            print(f"Error Message: {str(e)}")
            print("="*80 + "\n")
            return {
                "success": False,
                "uploaded": 0,
                "failed": len(emails),
                "errors": [str(e)]
            }
    
    def send_email_data(self, email_obj):
        """
        Legacy method for single email upload (for backwards compatibility).
        Now internally uses batch upload.
        """
        try:
            result = self.send_batch([email_obj])
            return result.get("success", False)
        except Exception as e:
            print(f"[API] Single email error: {e}")
            return False

