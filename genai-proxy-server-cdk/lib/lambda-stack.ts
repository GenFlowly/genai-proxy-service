import * as cdk from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGES } from '@genflowly/cdk-commons';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as path from 'path';
import {RESOURCE_NAMES} from "./constants";

export interface LambdaStackProps extends cdk.StackProps {
    stage: STAGES;
    ingestionQueue: sqs.IQueue;
    rawEmailBucket: s3.IBucket;
    processingRepo: ecr.IRepository;
}

export class LambdaStack extends cdk.Stack {

    public readonly ingestionLambda: lambda.Function;
    public readonly processingLambda: DockerImageFunction;

    constructor(scope: Construct, id: string, props: LambdaStackProps) {
        super(scope, id, props);

        /**
         * Lamda - Validates payload, pushes to SQS.
         */
        this.ingestionLambda = new lambda.Function(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingestion-lambda`, {
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../resources/ingestion')),
            environment: {
                QUEUE_URL: props.ingestionQueue.queueUrl,
            },
        });

        props.ingestionQueue.grantSendMessages(this.ingestionLambda);

        /**
         * Lamda - Ingests email payload, encode it and stores it in S3.
         */
        // TODO convert into step functions
        this.processingLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-processing-lambda`, {
            code: DockerImageCode.fromImageAsset(path.join(__dirname, '../resources/processing')),
            memorySize: 4096,
            timeout: cdk.Duration.seconds(300),
            environment: {
                BUCKET_NAME: props.rawEmailBucket.bucketName,
            },
        });

        props.ingestionQueue.grantConsumeMessages(this.processingLambda);

        this.processingLambda.addEventSource(new SqsEventSource(props.ingestionQueue));

        props.rawEmailBucket.grantPut(this.processingLambda);
    }
}
