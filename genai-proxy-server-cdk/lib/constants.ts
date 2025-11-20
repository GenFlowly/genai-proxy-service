import { Port } from 'aws-cdk-lib/aws-ec2';

const HTTP_PORT: Port = Port.tcp(80);

export const RESOURCE_NAMES = {
    // Gen AI Proxy Service
    GEN_AI_PROXY_SERVICE: 'gen-ai-proxy-service',
};
