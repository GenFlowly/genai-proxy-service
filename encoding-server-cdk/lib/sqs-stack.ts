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
    public readonly deadLetterQueue: sqs.IQueue;

    constructor(scope: Construct, id: string, props: SqsStackProps) {
        super(scope, id, props);

        // Create Dead Letter Queue for failed messages
        this.deadLetterQueue = new sqs.Queue(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-dlq`, {
            queueName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-dlq`,
            retentionPeriod: cdk.Duration.days(14), // Keep failed messages for 14 days
        });

        // Create main ingestion queue with DLQ
        this.ingestionQueue = new sqs.Queue(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-queue`, {
            queueName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-queue`,
            visibilityTimeout: cdk.Duration.seconds(5400), // 6x Lambda timeout (900s) = 5400s
            deadLetterQueue: {
                queue: this.deadLetterQueue,
                maxReceiveCount: 3, // Retry 3 times before sending to DLQ
            },
        });

        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-queue-output`, {
            value: this.ingestionQueue.queueUrl,
            description: 'Main ingestion queue URL',
        });

        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-dlq-output`, {
            value: this.deadLetterQueue.queueUrl,
            description: 'Dead letter queue URL for failed messages',
        });
    }
}
