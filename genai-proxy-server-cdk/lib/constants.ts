import { Port } from 'aws-cdk-lib/aws-ec2';

const HTTP_PORT: Port = Port.tcp(80);

export const RESOURCE_NAMES = {
    // Gen AI Proxy Service
    GEN_AI_PROXY_SERVICE: 'gen-ai-proxy-service',
};

// CDK bootstrap qualifier — fixed constant used by CDK across all accounts
export const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds';
export const CDK_DEPLOY_ROLE_NAME = (account: string, region: string) =>
    `cdk-${CDK_BOOTSTRAP_QUALIFIER}-deploy-role-${account}-${region}`;
