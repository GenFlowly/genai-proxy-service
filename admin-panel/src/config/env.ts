export const config = {
    auth0: {
        domain: import.meta.env.VITE_AUTH0_DOMAIN ?? '',
        clientId: import.meta.env.VITE_AUTH0_CLIENT_ID ?? '',
        audience: import.meta.env.VITE_AUTH0_AUDIENCE ?? '',
    },
    backend: {
        baseUrl: import.meta.env.VITE_BACKEND_URL ?? 'https://api-development.genflowly.com',
    },
}
