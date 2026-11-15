export const AUTH0_TOKEN_REQUEST = {
    url: "https://dev-abh5z7416lwy3xhv.us.auth0.com/oauth/token",
    method: "POST",
    body: {
        client_id: "QgQ45wDqkvY9x4iQsgZYzw226fjro1hX",
        code_verifier: "test-code-verifier",
        grant_type: "authorization_code",
        code: "test-authorization-code",
        redirect_uri: "http://localhost:3000"
    }
};

// Synthetic tokens: fake claims and a fake signature, never issued by Auth0.
export const AUTH0_TOKEN_RESPONSE = {
    access_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InRlc3Qta2V5In0.eyJpc3MiOiJodHRwczovL2Rldi1hYmg1ejc0MTZsd3kzeGh2LnVzLmF1dGgwLmNvbS8iLCJzdWIiOiJhdXRoMHx0ZXN0LXVzZXIiLCJhdWQiOlsiaHR0cHM6Ly9nZW5mbG93bHktYmV0YSIsImh0dHBzOi8vZGV2LWFiaDV6NzQxNmx3eTN4aHYudXMuYXV0aDAuY29tL3VzZXJpbmZvIl0sImlhdCI6MTc2NzU2NTUyMywiZXhwIjoxNzY3NjUxOTIzLCJzY29wZSI6Im9wZW5pZCBwcm9maWxlIGVtYWlsIn0.dGVzdC1zaWduYXR1cmU",
    id_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InRlc3Qta2V5In0.eyJuaWNrbmFtZSI6InRlc3QtdXNlciIsIm5hbWUiOiJUZXN0IFVzZXIiLCJwaWN0dXJlIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9hdmF0YXIucG5nIiwidXBkYXRlZF9hdCI6IjIwMjYtMDEtMDRUMjI6MjU6MjMuMzQzWiIsImVtYWlsIjoidGVzdC51c2VyQGV4YW1wbGUuY29tIiwiaXNzIjoiaHR0cHM6Ly9kZXYtYWJoNXo3NDE2bHd5M3hodi51cy5hdXRoMC5jb20vIiwiYXVkIjoiUWdRNDV3RHFrdlk5eDRpUXNnWll6dzIyNmZqcm8xaFgiLCJzdWIiOiJhdXRoMHx0ZXN0LXVzZXIiLCJpYXQiOjE3Njc1NjU1MjMsImV4cCI6MTc2NzYwMTUyMywic2lkIjoidGVzdC1zZXNzaW9uIiwibm9uY2UiOiJ0ZXN0LW5vbmNlIn0.dGVzdC1zaWduYXR1cmU",
    scope: "openid profile email",
    expires_in: 86400,
    token_type: "Bearer"
};

export const MOCK_USER = {
    nickname: "test-user",
    name: "Test User",
    picture: "https://example.com/avatar.png",
    updated_at: "2026-01-04T22:25:23.343Z",
    iss: "https://dev-abh5z7416lwy3xhv.us.auth0.com/",
    sub: "auth0|test-user",
    email: "test.user@example.com",
};
