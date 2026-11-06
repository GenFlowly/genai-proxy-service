import { Stack, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import { STAGES } from '@genflowly/cdk-commons';
import { RESOURCE_NAMES } from './constants';

export interface S3StackProps extends cdk.StackProps {
    stage: STAGES;
}

export class S3Stack extends Stack {
    public readonly attachmentsBucket: s3.Bucket;

    constructor(scope: Construct, id: string, props: S3StackProps) {
        super(scope, id, props);

        this.attachmentsBucket = new s3.Bucket(this, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-attachments`, {
            bucketName: `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-attachments`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            // Customer images: never auto-delete, and keep the bucket if the stack is torn down
            removalPolicy: RemovalPolicy.RETAIN,
            lifecycleRules: [
                {
                    // Agent scratch files (retrieval-server graph/fs_tools.py tags
                    // them) belong to one request, which no later request can
                    // address, and nothing records their conversation, so a
                    // conversation delete can't find them: they expire instead.
                    id: 'expire-agent-scratch',
                    tagFilters: { retention: 'scratch' },
                    expiration: cdk.Duration.days(1),
                },
            ],
            cors: [
                {
                    // Browser uploads/downloads go through presigned URLs, which carry
                    // their own auth — CORS here only has to let the browser make the call.
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
