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
import { RESOURCE_NAMES } from "./constants";

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
         * Ingestion Lambda - Validates payload, pushes to SQS.
         * Uses pre-built Docker image from ECR if INGESTION_IMAGE_URI is set (CI/CD).
         * Falls back to building from local Dockerfile if not set (local dev).
         */
        const ingestionImageUri = process.env.INGESTION_IMAGE_URI;

        const ingestionLambdaCode = ingestionImageUri
            ? DockerImageCode.fromEcr(props.processingRepo, {
                tagOrDigest: ingestionImageUri.split(':').pop() || 'latest',
            })
            : DockerImageCode.fromImageAsset(path.join(__dirname, '../../encoding-server'), {
                file: 'Dockerfile.ingestion',
            });

        this.ingestionLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingestion-lambda`, {
            code: ingestionLambdaCode,
            memorySize: 512,
            timeout: cdk.Duration.seconds(30),
            architecture: lambda.Architecture.ARM_64,
            environment: {
                QUEUE_URL: props.ingestionQueue.queueUrl,
            },
        });

        props.ingestionQueue.grantSendMessages(this.ingestionLambda);

        /**
         * Processing Lambda - Ingests email payload, encodes it and stores it in Zilliz + S3.
         * Uses heavy ML model (sentence-transformers) so requires more memory and timeout.
         * Uses pre-built Docker image from ECR if PROCESSING_IMAGE_URI is set (CI/CD).
         * Falls back to building from local Dockerfile if not set (local dev).
         */
        // TODO convert into step functions

        /**
         * Increase quota in AWS if needed for higher memory:
         * aws service-quotas request-service-quota-increase \
         *     --service-code lambda \
         *     --quota-code L-B99A9384 \
         *     --desired-value 10240
         */
        const processingImageUri = process.env.PROCESSING_IMAGE_URI;

        const processingLambdaCode = processingImageUri
            ? DockerImageCode.fromEcr(props.processingRepo, {
                tagOrDigest: processingImageUri.split(':').pop() || 'latest',
            })
            : DockerImageCode.fromImageAsset(path.join(__dirname, '../../encoding-server'), {
                file: 'Dockerfile.processing',
            });

        this.processingLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-processing-lambda`, {
            code: processingLambdaCode,
            memorySize: 3008,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.ARM_64,
            environment: {
                BUCKET_NAME: props.rawEmailBucket.bucketName,
                // Zilliz Cloud configuration - TODO: Move to Secrets Manager
                ZILLIZ_ENDPOINT: 'https://in03-0e3d96c83ea3190.serverless.aws-eu-central-1.cloud.zilliz.com',
                ZILLIZ_TOKEN: '27cc6072560645598da1fad99cc23a4f5bb89e916850c099d93a0e8128a5f853d9c586ee85e38147cd5006714234f94cdf247b5d',
                COLLECTION_NAME: 'test',
            },
        });

        props.ingestionQueue.grantConsumeMessages(this.processingLambda);

        this.processingLambda.addEventSource(new SqsEventSource(props.ingestionQueue));

        props.rawEmailBucket.grantPut(this.processingLambda);
    }
}
