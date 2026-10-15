import { Stack, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import { STAGES } from '@genflowly/cdk-commons';
import { RESOURCE_NAMES, RETENTION } from './constants';

export interface S3StackProps extends cdk.StackProps {
    stage: STAGES;
    /**
     * Enables the retention=pending expiry rule. Defaults to the
     * `enablePendingExpiry` context value, which cdk.json keeps false. Flip it
     * there, in a commit, only after the kept-object claim is live in
     * production and the one-time claim backfill has run in both stages
     * (genai-proxy-server development.md, "Retention"): until then linked
     * objects may still be tagged pending, and expiry counts from object
     * creation. A `-c enablePendingExpiry=true` on one deploy is undone by the
     * next CI deploy.
     */
    enablePendingExpiry?: boolean;
}

export class S3Stack extends Stack {
    public readonly attachmentsBucket: s3.Bucket;

    constructor(scope: Construct, id: string, props: S3StackProps) {
        super(scope, id, props);

        const enablePendingExpiry =
            props.enablePendingExpiry ?? String(this.node.tryGetContext('enablePendingExpiry')) === 'true';

        this.attachmentsBucket = new s3.Bucket(this, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-attachments`, {
            bucketName: `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-attachments`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            // Keep the bucket and its objects if the stack is ever torn down.
            // Object lifetime is the lifecycle rules' job below: they expire only
            // objects tagged scratch, derived or pending (not linked from any
            // message). Linked objects are tagged retention=kept and never expire
            // here; account deletion purges them.
            removalPolicy: RemovalPolicy.RETAIN,
            // Deliberately unversioned, so a purge's delete really removes the
            // bytes (a versioned bucket would only add a delete marker).
            versioned: false,
            lifecycleRules: [
                {
                    id: 'expire-scratch',
                    tagFilters: { [RETENTION.TAG]: RETENTION.SCRATCH },
                    expiration: Duration.days(RETENTION.SCRATCH_DAYS),
                },
                {
                    id: 'expire-derived',
                    tagFilters: { [RETENTION.TAG]: RETENTION.DERIVED },
                    expiration: Duration.days(RETENTION.DERIVED_DAYS),
                },
                {
                    id: 'expire-pending',
                    tagFilters: { [RETENTION.TAG]: RETENTION.PENDING },
                    expiration: Duration.days(RETENTION.PENDING_DAYS),
                    enabled: enablePendingExpiry,
                },
                {
                    id: 'abort-incomplete-multipart-uploads',
                    abortIncompleteMultipartUploadAfter: Duration.days(1),
                },
            ],
            cors: [
                {
                    // Browser uploads/downloads go through presigned URLs, which carry
                    // their own auth — CORS here only has to let the browser make the call.
                    // allowedHeaders '*' also admits the signed x-amz-tagging header.
                    allowedMethods: [
                        s3.HttpMethods.PUT,
                        s3.HttpMethods.GET,
                        s3.HttpMethods.HEAD,
                    ],
                    allowedOrigins: ['*'],
                    allowedHeaders: ['*'],
                    maxAge: 3600,
                },
            ],
        });

        new CfnOutput(this, 'AttachmentsBucketName', {
            value: this.attachmentsBucket.bucketName,
            description: 'Set this as ATTACHMENTS_BUCKET on the Fly.io apps',
        });

        new CfnOutput(this, 'AttachmentsBucketArn', {
            value: this.attachmentsBucket.bucketArn,
        });
    }
}
