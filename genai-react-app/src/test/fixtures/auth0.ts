export const AUTH0_TOKEN_REQUEST = {
    url: "https://dev-abh5z7416lwy3xhv.us.auth0.com/oauth/token",
    method: "POST",
    body: {
        client_id: "QgQ45wDqkvY9x4iQsgZYzw226fjro1hX",
        code_verifier: "Eq45lA6iXDWo~iXZXhl4gqaJ-p.Et.ro91cYyClBjb~",
        grant_type: "authorization_code",
        code: "pBPVtgTBzFmLqDoaYnlJYSlv225JKQruI41hzpoqosdR3",
        redirect_uri: "http://localhost:3000"
    }
};

export const AUTH0_TOKEN_RESPONSE = {
    access_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InpqYUNCU1ZmUE84bk80NmZ0Q0VrSCJ9...", // Truncated for brevity in variable name but full content below
    id_token: "***REDACTED***",
    scope: "openid profile email",
    expires_in: 86400,
    token_type: "Bearer"
};

// Extracted from the provided id_token (JWT)
export const MOCK_USER = {
    nickname: "nkirit",
    name: "Neel",
    picture: "https://avatars.githubusercontent.com/u/7536192?v=4",
    updated_at: "2026-01-04T22:25:23.343Z",
    iss: "https://dev-abh5z7416lwy3xhv.us.auth0.com/",
    sub: "github|7536192",
    email: "neel@example.com", // Added for completeness though not in snippet provided explicitly, usually strictly implied by 'email' scope
}; 
