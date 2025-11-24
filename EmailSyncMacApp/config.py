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
AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN", "dev-abh5z7416lwy3xhv.us.auth0.com")
AUTH0_CLIENT_ID = os.getenv("AUTH0_CLIENT_ID", "QgQ45wDqkvY9x4iQsgZYzw226fjro1hX")
AUTH0_CALLBACK_URL = os.getenv("AUTH0_CALLBACK_URL", "http://localhost:8080/callback")
AUTH0_SCOPES = os.getenv("AUTH0_SCOPES", "openid profile email")

# IMPORTANT: Set this to your API identifier in Auth0 to get JWT access tokens
# Without this, Auth0 returns opaque tokens that API Gateway cannot validate
AUTH0_AUDIENCE = os.getenv("AUTH0_AUDIENCE", "https://9rwqqmvex2.execute-api.us-east-1.amazonaws.com")

# API Configuration
# Change based on environment (dev, staging, production)
API_BASE_URL = os.getenv("API_BASE_URL", "https://9rwqqmvex2.execute-api.us-east-1.amazonaws.com/development")
API_BATCH_ENDPOINT = os.getenv("API_BATCH_ENDPOINT", "/sync")


