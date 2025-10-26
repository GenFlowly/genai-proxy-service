export const config = {
    auth0: {
        domain: process.env.REACT_APP_AUTH0_DOMAIN ?? '',
        clientId: process.env.REACT_APP_AUTH0_CLIENT_ID ?? '',
        audience: process.env.REACT_APP_AUTH0_AUDIENCE ?? '',
    },
    backend: {
        baseUrl: process.env.REACT_APP_BACKEND_URL ?? 'http://EcsSta-genai-2161FSA3WV0z-1198870077.us-east-1.elb.amazonaws.com',
    },
};
