export const config = {
    auth0: {
        domain: process.env.REACT_APP_AUTH0_DOMAIN ?? '',
        clientId: process.env.REACT_APP_AUTH0_CLIENT_ID ?? '',
        audience: process.env.REACT_APP_AUTH0_AUDIENCE ?? '',
    },
    backend: {
        baseUrl: process.env.REACT_APP_BACKEND_URL ?? 'https://api-development.genflowly.com',
    },
};
