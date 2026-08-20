import * as cdk from 'aws-cdk-lib';
import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGES } from '@genflowly/cdk-commons';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { RESOURCE_NAMES } from './constants';

export interface S3StackProps extends cdk.StackProps {
    stage: STAGES;
}

export class S3Stack extends cdk.Stack {

    public readonly rawEmailBucket: s3.IBucket;
    public readonly customerDocumentsBucket: s3.IBucket;

    constructor(scope: Construct, id: string, props: S3StackProps) {
        super(scope, id, props);

        // Use DESTROY for development, RETAIN for production
        const removalPolicy = props.stage === STAGES.BETA ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

        this.rawEmailBucket = new s3.Bucket(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-bucket`, {
            bucketName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-bucket`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: removalPolicy,
            autoDeleteObjects: props.stage === STAGES.BETA, // Required for DESTROY to work
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // Per-customer document store. One bucket, per-customer prefix (multi-tenant
        // standard — avoids the per-account bucket ceiling). Layout:
        //   {customerId}/notes/{noteKey}.json
        //   {customerId}/emails/{messageId}.json
        // Also holds transient batch staging under _staging/{batchId}.json (expired
        // by lifecycle rule; the per-document objects are durable).
        this.customerDocumentsBucket = new s3.Bucket(this, `genflowly-${props.stage}-customer-documents`, {
            bucketName: `genflowly-${props.stage}-customer-documents`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: removalPolicy,
            autoDeleteObjects: props.stage === STAGES.BETA,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            lifecycleRules: [
                {
                    id: 'expire-batch-staging',
                    prefix: '_staging/',
                    expiration: cdk.Duration.days(3),
                },
            ],
        });

        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-bucket-output`, {
            value: this.rawEmailBucket.bucketName,
        });

        new CfnOutput(this, `genflowly-${props.stage}-customer-documents-output`, {
            value: this.customerDocumentsBucket.bucketName,
        });
    }
}
