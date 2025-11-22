import webbrowser
import secrets
import hashlib
import base64
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlencode, parse_qs, urlparse
import requests
from authlib.integrations.requests_client import OAuth2Session
import config

class CallbackHandler(BaseHTTPRequestHandler):
    """HTTP request handler for OAuth callback"""
    
    def do_GET(self):
        # Parse the callback URL
        query = parse_qs(urlparse(self.path).query)
        
        if 'code' in query:
            # Authorization code received
            self.server.auth_code = query['code'][0]
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<html><body><h1>Authentication Successful!</h1><p>You can close this window and return to the app.</p></body></html>')
        elif 'error' in query:
            # Error from Auth0
            self.server.auth_error = query.get('error_description', ['Unknown error'])[0]
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(f'<html><body><h1>Authentication Failed</h1><p>{self.server.auth_error}</p></body></html>'.encode())
        
    def log_message(self, format, *args):
        # Suppress logging
        pass


class Auth0Client:
    def __init__(self):
        self.domain = config.AUTH0_DOMAIN
        self.client_id = config.AUTH0_CLIENT_ID
        self.callback_url = config.AUTH0_CALLBACK_URL
        self.scopes = config.AUTH0_SCOPES
        
        self.access_token = None
        self.id_token = None
        self.user_info = None
    
    def generate_pkce_pair(self):
        """Generate PKCE code verifier and challenge"""
        code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('utf-8').rstrip('=')
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode('utf-8')).digest()
        ).decode('utf-8').rstrip('=')
        return code_verifier, code_challenge
    
    def login(self):
        """Start the OAuth login flow"""
        try:
            # Generate PKCE pair
            code_verifier, code_challenge = self.generate_pkce_pair()
            
            # Build authorization URL
            auth_params = {
                'client_id': self.client_id,
                'response_type': 'code',
                'redirect_uri': self.callback_url,
                'audience': config.AUTH0_AUDIENCE,
                'scope': self.scopes,
                'code_challenge': code_challenge,
                'code_challenge_method': 'S256'
            }
            
            auth_url = f"https://{self.domain}/authorize?{urlencode(auth_params)}"
            
            # Open browser
            webbrowser.open(auth_url)
            
            # Start local server to receive callback
            server = HTTPServer(('localhost', 8080), CallbackHandler)
            server.auth_code = None
            server.auth_error = None
            server.timeout = 120  # 2 minute timeout
            
            # Wait for callback (single request)
            server.handle_request()
            
            if server.auth_error:
                return False, server.auth_error
            
            if not server.auth_code:
                return False, "No authorization code received"
            
            # Exchange code for tokens
            token_url = f"https://{self.domain}/oauth/token"
            token_data = {
                'grant_type': 'authorization_code',
                'client_id': self.client_id,
                'code': server.auth_code,
                'redirect_uri': self.callback_url,
                'code_verifier': code_verifier
            }
            
            response = requests.post(token_url, json=token_data)
            
            if response.status_code != 200:
                return False, f"Token exchange failed: {response.text}"
            
            tokens = response.json()
            self.access_token = tokens.get('access_token')
            self.id_token = tokens.get('id_token')
            
            # Debug: Log token info
            print(f"\n[Auth0] Token Exchange Successful")
            print(f"[Auth0] Access Token: {self.access_token[:50] if self.access_token else 'None'}...")
            print(f"[Auth0] ID Token: {self.id_token[:50] if self.id_token else 'None'}...")
            print(f"[Auth0] Access Token Type: {'JWT' if self.access_token and self.access_token.count('.') == 2 else 'JWE/Opaque'}\n")
            
            # Get user info
            self.user_info = self.get_user_info()
            
            return True, "Login successful"
            
        except Exception as e:
            return False, f"Login error: {str(e)}"
    
    def get_user_info(self):
        """Fetch user information from Auth0"""
        if not self.access_token:
            return None
        
        try:
            userinfo_url = f"https://{self.domain}/userinfo"
            headers = {'Authorization': f'Bearer {self.access_token}'}
            response = requests.get(userinfo_url, headers=headers)
            
            if response.status_code == 200:
                return response.json()
            return None
        except:
            return None
    
    def logout(self):
        """Clear tokens and user info"""
        self.access_token = None
        self.id_token = None
        self.user_info = None
    
    def is_authenticated(self):
        """Check if user is authenticated"""
        return self.access_token is not None
