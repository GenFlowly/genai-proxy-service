import os
from dotenv import load_dotenv

# Load environment variables from .env file if present
# Determine environment (default to 'development')
app_env = os.getenv("APP_ENV", "development")
env_file = f".env.{app_env}"

# Try to load the specific env file (e.g., .env.development)
# If not found, load_dotenv will silently fail (or we can fallback to .env)
# We explicitly look for the file to be sure.
if os.path.exists(env_file):
    load_dotenv(env_file)
else:
    # Fallback to standard .env
    load_dotenv()

# Auth0 Configuration
AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN", "auth.genflowly.com")
AUTH0_CLIENT_ID = os.getenv("AUTH0_CLIENT_ID", "VSKaAyEXLKM0LuZzJVhvH6RTT11LiNgE")
AUTH0_CALLBACK_URL = os.getenv("AUTH0_CALLBACK_URL", "http://localhost:8080/callback")
AUTH0_SCOPES = os.getenv("AUTH0_SCOPES", "openid profile email")

# IMPORTANT: Set this to your API identifier in Auth0 to get JWT access tokens
# Without this, Auth0 returns opaque tokens that API Gateway cannot validate
AUTH0_AUDIENCE = os.getenv("AUTH0_AUDIENCE", "https://pzf0twaaq5.execute-api.us-east-1.amazonaws.com")

# API Configuration
# Change based on environment (dev, staging, production)
API_BASE_URL = os.getenv("API_BASE_URL", "https://api-development.genflowly.com")
API_BATCH_ENDPOINT = os.getenv("API_BATCH_ENDPOINT", "/encode-email")

# Client identifier sent in the request envelope (the server requires one)
API_CLIENT_NAME = os.getenv("API_CLIENT_NAME", "EMAIL_SYNC_MAC")

# Embedding model requested for email encoding. Must match the model the
# customer's collections were created with — the collection name embeds the
# model and its schema fixes the vector dimension.
EMBEDDING_MODEL_TYPE = os.getenv("EMBEDDING_MODEL_TYPE", "voyage")
EMBEDDING_MODEL_NAME = os.getenv("EMBEDDING_MODEL_NAME", "voyage-4-large")
