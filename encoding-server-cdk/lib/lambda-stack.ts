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
    ingestionImageTag?: string;
    parseAndChunkImageTag?: string;
    zillizEndpoint: string;
    zillizToken: string;
    customerProfileTableName: string;
    customerVectorDBConfigTableName: string;
}

export class LambdaStack extends cdk.Stack {

    public readonly ingestionLambda: lambda.Function;
    public readonly ingestNotesLambda: lambda.Function;
    public readonly parseAndChunkLambda: DockerImageFunction;

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
            timeout: cdk.Duration.seconds(900),
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
            memorySize: 1024,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
        });
    }
}
