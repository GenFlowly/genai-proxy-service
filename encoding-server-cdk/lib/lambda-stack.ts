import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGES } from '@genflowly/cdk-commons';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { RESOURCE_NAMES } from "./constants";

export interface LambdaStackProps extends cdk.StackProps {
    stage: STAGES;
    rawEmailBucket: s3.IBucket;
    ingestionQueue: sqs.IQueue;
    ingestionRepo: ecr.IRepository;
    encodeRepo: ecr.IRepository;
    storeEmbeddingsRepo: ecr.IRepository;
    storeS3Repo: ecr.IRepository;
    ingestionImageTag?: string;
    encodeImageTag?: string;
    storeEmbeddingsImageTag?: string;
    storeS3ImageTag?: string;
    zillizEndpoint: string;
    zillizToken: string;
    customerProfileTableName: string;
    customerVectorDBConfigTableName: string;
}

export class LambdaStack extends cdk.Stack {

    public readonly ingestionLambda: lambda.Function;
    public readonly ingestNotesLambda: lambda.Function;
    public readonly encodeLambda: DockerImageFunction;
    public readonly storeEmbeddingsLambda: DockerImageFunction;
    public readonly storeS3Lambda: DockerImageFunction;

    constructor(scope: Construct, id: string, props: LambdaStackProps) {
        super(scope, id, props);

        // Import CustomerProfile table
        const customerProfileTable = dynamodb.Table.fromTableName(this, 'CustomerProfileTable', props.customerProfileTableName);
        const customerVectorDBConfigTable = dynamodb.Table.fromTableName(this, 'CustomerVectorDBConfigTable', props.customerVectorDBConfigTableName);

        /**
         * Ingestion Lambda
         * Validates payloads and pushes to SQS
         */
        const ingestionLambdaCode = DockerImageCode.fromEcr(props.ingestionRepo, {
            tagOrDigest: props.ingestionImageTag || 'ingestion-latest',
        });

        this.ingestionLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingestion-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingestion-lambda`,
            code: ingestionLambdaCode,
            memorySize: 512,
            timeout: cdk.Duration.seconds(30),
            architecture: lambda.Architecture.X86_64,
            environment: {
                QUEUE_URL: props.ingestionQueue.queueUrl,
                CUSTOMER_PROFILE_TABLE_NAME: props.customerProfileTableName,
            },
        });

        props.ingestionQueue.grantSendMessages(this.ingestionLambda);
        customerProfileTable.grantReadData(this.ingestionLambda);

        /**
         * Ingest Notes Lambda
         * Validates notes payloads and pushes to SQS
         */
        this.ingestNotesLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingest-notes-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingest-notes-lambda`,
            code: ingestionLambdaCode,
            memorySize: 512,
            timeout: cdk.Duration.seconds(30),
            architecture: lambda.Architecture.X86_64,
            environment: {
                QUEUE_URL: props.ingestionQueue.queueUrl,
                CUSTOMER_PROFILE_TABLE_NAME: props.customerProfileTableName,
            },
        });

        props.ingestionQueue.grantSendMessages(this.ingestNotesLambda);
        customerProfileTable.grantReadData(this.ingestNotesLambda);

        /**
         * Processing Workflow
         * Split into 3 steps: Encode -> Store Zilliz -> Store S3
         */

        // 1. Encode Lambda
        this.encodeLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-encode-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-encode-lambda`,
            code: DockerImageCode.fromEcr(props.encodeRepo, {
                tagOrDigest: props.encodeImageTag || 'encode-latest',
                cmd: ['handlers.encode_lambda.handler'],
            }),
            memorySize: 3008, // Needs memory for model
            timeout: cdk.Duration.seconds(300),
            architecture: lambda.Architecture.X86_64,
        });

        // 2. Store Embeddings Lambda
        this.storeEmbeddingsLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-embeddings-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-embeddings-lambda`,
            code: DockerImageCode.fromEcr(props.storeEmbeddingsRepo, {
                tagOrDigest: props.storeEmbeddingsImageTag || 'store-embeddings-latest',
                cmd: ['handlers.store_embeddings_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(60),
            architecture: lambda.Architecture.X86_64,
            environment: {
                ZILLIZ_ENDPOINT: props.zillizEndpoint,
                ZILLIZ_TOKEN: props.zillizToken,
                COLLECTION_NAME: 'test',
                CUSTOMER_VECTOR_DB_CONFIG_TABLE: props.customerVectorDBConfigTableName,
            },
        });

        // Grant permissions to access Zilliz credentials from DynamoDB and decrypt them via KMS
        customerVectorDBConfigTable.grantReadData(this.storeEmbeddingsLambda);
        this.storeEmbeddingsLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'], // Needs to decrypt tokens with the KMS key
        }));

        // 3. Store S3 Lambda
        this.storeS3Lambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-s3-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-s3-lambda`,
            code: DockerImageCode.fromEcr(props.storeS3Repo, {
                tagOrDigest: props.storeS3ImageTag || 'store-s3-latest',
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
