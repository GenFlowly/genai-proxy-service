import { Port } from 'aws-cdk-lib/aws-ec2';

const HTTP_PORT: Port = Port.tcp(80);

export const RESOURCE_NAMES = {
    // Gen AI Proxy Service
    GEN_AI_PROXY_SERVICE: 'gen-ai-proxy-service',
};

// Object retention tags on the attachments bucket (genai-proxy-server
// development.md, "Retention"). The services write the tag; the bucket's
// lifecycle rules expire by it.
export const RETENTION = {
    TAG: 'retention',
    /** agent-fs scratch and oversized tool-output spills */
    SCRATCH: 'scratch',
    SCRATCH_DAYS: 7,
    /** regenerable sidecars (e.g. extracted PDF text) */
    DERIVED: 'derived',
    DERIVED_DAYS: 30,
    /** written but not (yet) linked from a message row */
    PENDING: 'pending',
    PENDING_DAYS: 7,
};

/** The encoding-server's versioned per-customer document store (encoding-server-cdk). */
export const CUSTOMER_DOCUMENTS_BUCKET_NAME = (stage: string) => `genflowly-${stage}-customer-documents`;

// CDK bootstrap qualifier — fixed constant used by CDK across all accounts
export const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds';
export const CDK_DEPLOY_ROLE_NAME = (account: string, region: string) =>
    `cdk-${CDK_BOOTSTRAP_QUALIFIER}-deploy-role-${account}-${region}`;
