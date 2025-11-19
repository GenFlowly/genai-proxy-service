import * as cdk from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGES } from '@genflowly/cdk-commons';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { RESOURCE_NAMES } from './constants';

export interface SqsStackProps extends cdk.StackProps {
    stage: STAGES;
}

export class SqsStack extends cdk.Stack {

    public readonly ingestionQueue: sqs.IQueue;

    constructor(scope: Construct, id: string, props: SqsStackProps) {
        super(scope, id, props);

        this.ingestionQueue = new sqs.Queue(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-queue`, {
            queueName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-queue`,
            visibilityTimeout: cdk.Duration.seconds(300),
        });

        new CfnOutput(this, 'IngestionQueueUrl', {
            value: this.ingestionQueue.queueUrl,
        });
    }
}
