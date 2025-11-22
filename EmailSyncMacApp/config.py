# Auth0 Configuration

AUTH0_DOMAIN = "dev-abh5z7416lwy3xhv.us.auth0.com"
AUTH0_CLIENT_ID = "QgQ45wDqkvY9x4iQsgZYzw226fjro1hX"
AUTH0_CALLBACK_URL = "http://localhost:8080/callback"
AUTH0_SCOPES = "openid profile email"
# IMPORTANT: Set this to your API identifier in Auth0 to get JWT access tokens
# Without this, Auth0 returns opaque tokens that API Gateway cannot validate
AUTH0_AUDIENCE = "https://avathinrxa.execute-api.us-east-1.amazonaws.com"

# API Configuration
# Change based on environment (dev, staging, production)
API_BASE_URL = "https://avathinrxa.execute-api.us-east-1.amazonaws.com/development"
API_BATCH_ENDPOINT = "/sync"  # Updated to match the backend endpoint

# Optional: You can also use environment variables
# import os
# AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN", "dev-abh5z7416lwy3xhv.us.auth0.com")
# AUTH0_CLIENT_ID = os.getenv("AUTH0_CLIENT_ID", "QgQ45wDqkvY9x4iQsgZYzw226fjro1hX")
# API_BASE_URL = os.getenv("API_BASE_URL", "https://api.example.com")

