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
    id_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InpqYUNCU1ZmUE84bk80NmZ0Q0VrSCJ9.eyJuaWNrbmFtZSI6Im5raXJpdCIsIm5hbWUiOiJOZWVsIiwicGljdHVyZSI6Imh0dHBzOi8vYXZhdGFycy5naXRodWJ1c2VyY29udGVudC5jb20vdS83NTM2MTkyP3Y9NCIsInVwZGF0ZWRfYXQiOiIyMDI2LTAxLTA0VDIyOjI1OjIzLjM0M1oiLCJpc3MiOiJodHRwczovL2Rldi1hYmg1ejc0MTZsd3kzeGh2LnVzLmF1dGgwLmNvbS8iLCJhdWQiOiJRZ1E0NXdEcWt2WTl4NGlRc2daWXp3MjI2ZmpybzFoWCIsInN1YiI6ImdpdGh1Ynw3NTM2MTkyIiwiaWF0IjoxNzY3NTY1NTI1LCJleHAiOjE3Njc2MDE1MjUsInNpZCI6Imo4c3B1SmxxbVZhTTRlc2VnSmFNOHBKaFJaSzZBNXVWIiwibm9uY2UiOiJkRGhHYmt3NGJGSkhRMFJEUnpOcU5XbFZWMW81UzFsSmVuWm9ORzl6TFRFeWZqWitWVlJIVm5kZlJ3PT0ifQ.ZEWvX91tZtPhL9IxsrALNVzf67a5m69fLflZtmPQNlXohH3UgT9n_tf-bB62Xq67fPWT4uORbqiiaH1q1R4YujyH1Ohme2uV5KtMXKvxeLJ8eWMlPYdKut4xg603uxWOXMUq1Fxt2Y6I-yRw2TFK2DR7XNkwKcNznr3Sz1FEWpbUNIeCAS9DpkGygZdeVxoSyAS89PyPE60AAhDpIk_on9uNbBLru3KhJVs-g6MMsAb8qsICx2pTH0Vw1350C9L67VacYETIJCuKeSpMgXdeYYEL3n2FAr3S6yZBCc6JphFrOVi4SprQ4lVRhpxpeZqhSYq11es_KKuCcTcMDg6Svg",
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
