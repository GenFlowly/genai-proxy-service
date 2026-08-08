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
    parseAndChunkRepo: ecr.IRepository;
    embedRepo: ecr.IRepository;
    storeEmbeddingsRepo: ecr.IRepository;
    ingestionImageTag?: string;
    parseAndChunkImageTag?: string;
    embedImageTag?: string;
    storeEmbeddingsImageTag?: string;
    zillizEndpoint: string;
    zillizToken: string;
    customerProfileTableName: string;
    customerVectorDBConfigTableName: string;
}

export class LambdaStack extends cdk.Stack {

    public readonly ingestEmailLambda: lambda.Function;
    public readonly ingestNotesLambda: lambda.Function;
    public readonly parseAndChunkLambda: DockerImageFunction;
    public readonly embedLambda: DockerImageFunction;
    public readonly storeEmbeddingsLambda: DockerImageFunction;
    public readonly createCollectionsLambda: DockerImageFunction;
    public readonly checkCollectionsLambda: DockerImageFunction;

    constructor(scope: Construct, id: string, props: LambdaStackProps) {
        super(scope, id, props);

        // Import CustomerProfile table
        const customerProfileTable = dynamodb.Table.fromTableName(this, 'CustomerProfileTable', props.customerProfileTableName);
        const customerVectorDBConfigTable = dynamodb.Table.fromTableName(this, 'CustomerVectorDBConfigTable', props.customerVectorDBConfigTableName);

        /**
         * Ingest Email Lambda
         * Validates payloads and pushes to SQS
         */
        this.ingestEmailLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingest-email-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingest-email-lambda`,
            code: DockerImageCode.fromEcr(props.ingestionRepo, {
                tagOrDigest: props.ingestionImageTag || 'ingestion-latest',
                cmd: ['handlers.ingest_email_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                QUEUE_URL: props.ingestionQueue.queueUrl,
                CUSTOMER_PROFILE_TABLE_NAME: props.customerProfileTableName,
            },
        });

        props.ingestionQueue.grantSendMessages(this.ingestEmailLambda);
        customerProfileTable.grantReadData(this.ingestEmailLambda);

        /**
         * Ingest Notes Lambda
         * Validates notes payloads and pushes to SQS
         */
        this.ingestNotesLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingest-notes-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingest-notes-lambda`,
            code: DockerImageCode.fromEcr(props.ingestionRepo, {
                tagOrDigest: props.ingestionImageTag || 'ingestion-latest',
                cmd: ['handlers.ingest_notes_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(900),
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
         * Split into 4 steps: ParseAndChunk -> Encode -> Store Zilliz -> Store S3
         */

        // 0. Parse And Chunk Lambda
        this.parseAndChunkLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-parse-and-chunk-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-parse-and-chunk-lambda`,
            code: DockerImageCode.fromEcr(props.parseAndChunkRepo, {
                tagOrDigest: props.parseAndChunkImageTag || 'parse-and-chunk-latest',
                cmd: ['handlers.parse_and_chunk_lambda.handler'],
            }),
            memorySize: 3008,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                JOBLIB_TEMP_FOLDER: '/tmp',
            },
        });

        // 1. Embed Lambda natively decoupled
        this.embedLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-embeddings-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-embeddings-lambda`,
            code: DockerImageCode.fromEcr(props.embedRepo, {
                tagOrDigest: props.embedImageTag || 'embed-latest',
                cmd: ['handlers.create_embeddings_lambda.handler'],
            }),
            memorySize: 3008,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                JOBLIB_TEMP_FOLDER: '/tmp',
            },
        });

        // 2. Store Embeddings Lambda natively rewritten cleanly
        this.storeEmbeddingsLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-embeddings-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-embeddings-lambda`,
            code: DockerImageCode.fromEcr(props.storeEmbeddingsRepo, {
                tagOrDigest: props.storeEmbeddingsImageTag || 'store-embeddings-latest',
                cmd: ['handlers.store_embeddings_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                ZILLIZ_ENDPOINT: props.zillizEndpoint,
                ZILLIZ_TOKEN: props.zillizToken,
                CUSTOMER_VECTOR_DB_CONFIG_TABLE: props.customerVectorDBConfigTableName,
            },
        });

        // Expose cryptographic arrays perfectly mapping AWS natively safely
        customerVectorDBConfigTable.grantReadData(this.storeEmbeddingsLambda);
        this.storeEmbeddingsLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'], 
        }));

        /**
         * Create Collections Lambda
         * Explicit API endpoint handler for Zilliz collection generation
         */
        this.createCollectionsLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-collections-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-collections-lambda`,
            code: DockerImageCode.fromEcr(props.storeEmbeddingsRepo, {
                tagOrDigest: props.storeEmbeddingsImageTag || 'store-embeddings-latest',
                cmd: ['handlers.create_collections_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                ZILLIZ_ENDPOINT: props.zillizEndpoint,
                ZILLIZ_TOKEN: props.zillizToken,
                CUSTOMER_PROFILE_TABLE_NAME: props.customerProfileTableName,
                CUSTOMER_VECTOR_DB_CONFIG_TABLE: props.customerVectorDBConfigTableName,
            },
        });

        customerProfileTable.grantReadData(this.createCollectionsLambda);
        customerVectorDBConfigTable.grantReadData(this.createCollectionsLambda);
        this.createCollectionsLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'], 
        }));

        /**
         * Check Collections Lambda
         * Explicit API endpoint handler for checking Zilliz collections
         */
        this.checkCollectionsLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-check-collections-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-check-collections-lambda`,
            code: DockerImageCode.fromEcr(props.storeEmbeddingsRepo, {
                tagOrDigest: props.storeEmbeddingsImageTag || 'store-embeddings-latest',
                cmd: ['handlers.check_collections_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(30),
            architecture: lambda.Architecture.X86_64,
            environment: {
                ZILLIZ_ENDPOINT: props.zillizEndpoint,
                ZILLIZ_TOKEN: props.zillizToken,
                CUSTOMER_PROFILE_TABLE_NAME: props.customerProfileTableName,
                CUSTOMER_VECTOR_DB_CONFIG_TABLE: props.customerVectorDBConfigTableName,
            },
        });

        customerProfileTable.grantReadData(this.checkCollectionsLambda);
        customerVectorDBConfigTable.grantReadData(this.checkCollectionsLambda);
        this.checkCollectionsLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'], 
        }));
    }
}
