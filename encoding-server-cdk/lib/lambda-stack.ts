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
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'path';
import { RESOURCE_NAMES } from "./constants";

export interface LambdaStackProps extends cdk.StackProps {
    stage: STAGES;
    rawEmailBucket: s3.IBucket;
    ingestionQueue: sqs.IQueue;
    ingestionRepo: ecr.IRepository;
    encodeRepo: ecr.IRepository;
    storeEmbeddingsRepo: ecr.IRepository;
    storeS3Repo: ecr.IRepository;
}

export class LambdaStack extends cdk.Stack {

    public readonly ingestionLambda: lambda.Function;
    public readonly encodeLambda: DockerImageFunction;
    public readonly storeEmbeddingsLambda: DockerImageFunction;
    public readonly storeS3Lambda: DockerImageFunction;

    constructor(scope: Construct, id: string, props: LambdaStackProps) {
        super(scope, id, props);

        /**
         * Ingestion Lambda
         * Validates payloads and pushes to SQS
         */
        const ingestionLambdaCode = DockerImageCode.fromEcr(props.ingestionRepo, {
            tagOrDigest: 'ingestion-latest',
        });

        this.ingestionLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingestion-lambda`, {
            code: ingestionLambdaCode,
            memorySize: 512,
            timeout: cdk.Duration.seconds(30),
            architecture: lambda.Architecture.X86_64,
            environment: {
                QUEUE_URL: props.ingestionQueue.queueUrl,
            },
        });

        props.ingestionQueue.grantSendMessages(this.ingestionLambda);

        /**
         * Processing Workflow
         * Split into 3 steps: Encode -> Store Zilliz -> Store S3
         */

        // 1. Encode Lambda
        this.encodeLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-encode-lambda`, {
            code: DockerImageCode.fromEcr(props.encodeRepo, {
                tagOrDigest: 'encode-latest',
                cmd: ['handlers.encode_lambda.handler'],
            }),
            memorySize: 3008, // Needs memory for model
            timeout: cdk.Duration.seconds(300),
            architecture: lambda.Architecture.X86_64,
        });

        // 2. Store Embeddings Lambda
        this.storeEmbeddingsLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-embeddings-lambda`, {
            code: DockerImageCode.fromEcr(props.storeEmbeddingsRepo, {
                tagOrDigest: 'store-embeddings-latest',
                cmd: ['handlers.store_embeddings_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(60),
            architecture: lambda.Architecture.X86_64,
            environment: {
                // Zilliz Cloud configuration - TODO: Move to Secrets Manager
                ZILLIZ_ENDPOINT: 'https://in03-0e3d96c83ea3190.serverless.aws-eu-central-1.cloud.zilliz.com',
                ZILLIZ_TOKEN: '27cc6072560645598da1fad99cc23a4f5bb89e916850c099d93a0e8128a5f853d9c586ee85e38147cd5006714234f94cdf247b5d',
                COLLECTION_NAME: 'test',
            },
        });

        // 3. Store S3 Lambda
        this.storeS3Lambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-s3-lambda`, {
            code: DockerImageCode.fromEcr(props.storeS3Repo, {
                tagOrDigest: 'store-s3-latest',
                cmd: ['handlers.store_in_s3_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(60),
            architecture: lambda.Architecture.X86_64,
            environment: {
                BUCKET_NAME: props.rawEmailBucket.bucketName,
            },
        });

        props.rawEmailBucket.grantPut(this.storeS3Lambda);
    }
}
