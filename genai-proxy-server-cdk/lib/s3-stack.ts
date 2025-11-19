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

    constructor(scope: Construct, id: string, props: S3StackProps) {
        super(scope, id, props);

        this.rawEmailBucket = new s3.Bucket(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-bucket`, {
            bucketName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-bucket`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: RemovalPolicy.RETAIN,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-bucket-output`, {
            value: this.rawEmailBucket.bucketName,
        });
    }
}
