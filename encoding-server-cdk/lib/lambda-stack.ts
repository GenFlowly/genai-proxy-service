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
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { RESOURCE_NAMES } from "./constants";

export interface LambdaStackProps extends cdk.StackProps {
    stage: STAGES;
    rawEmailBucket: s3.IBucket;
    customerDocumentsBucket: s3.IBucket;
    ingestionQueue: sqs.IQueue;
    ingestionRepo: ecr.IRepository;
    parseAndChunkRepo: ecr.IRepository;
    embedRepo: ecr.IRepository;
    storeEmbeddingsRepo: ecr.IRepository;
    createCollectionsRepo: ecr.IRepository;
    ingestionImageTag?: string;
    parseAndChunkImageTag?: string;
    embedImageTag?: string;
    storeEmbeddingsImageTag?: string;
    createCollectionsImageTag?: string;
    zillizEndpoint: string;
    zillizToken: string;
    customerProfileTableName: string;
    customerVectorDBConfigTableName: string;
    customerNotesTableName: string;
    instructionsTableName: string;
    voyageApiKey?: string;
    /** Auth0 client ids allowed to call POST /purge-vectors (comma-separated; empty refuses all). */
    purgeAllowedClientIds?: string;
}

export class LambdaStack extends cdk.Stack {

    public readonly ingestEmailLambda: lambda.Function;
    public readonly ingestNotesLambda: lambda.Function;
    public readonly parseAndChunkLambda: DockerImageFunction;
    public readonly embedLambda: DockerImageFunction;
    public readonly storeEmbeddingsLambda: DockerImageFunction;
    public readonly createCollectionsLambda: DockerImageFunction;
    public readonly purgeVectorsLambda: DockerImageFunction;
    public readonly pollVoyageBatchesLambda: DockerImageFunction;
    public readonly accumulateVoyageNotesLambda: DockerImageFunction;
    public readonly voyageBatchJobsTable: dynamodb.Table;

    constructor(scope: Construct, id: string, props: LambdaStackProps) {
        super(scope, id, props);

        // Import CustomerProfile table
        const customerProfileTable = dynamodb.Table.fromTableName(this, 'CustomerProfileTable', props.customerProfileTableName);
        const customerVectorDBConfigTable = dynamodb.Table.fromTableName(this, 'CustomerVectorDBConfigTable', props.customerVectorDBConfigTableName);
        // Imported with its sparse GSI so grants cover Query on the index (used by the notes accumulator)
        const customerNotesTable = dynamodb.Table.fromTableAttributes(this, 'CustomerNotesTable', {
            tableName: props.customerNotesTableName,
            grantIndexPermissions: true,
        });
        const NOTES_EMBEDDING_STATUS_INDEX = 'embedding-status-index';
        const instructionsTable = dynamodb.Table.fromTableName(this, 'InstructionsTable', props.instructionsTableName);

        // Drives each lambda's log level and user-content gating — see
        // genai-proxy-server/development.md "Logging policy".
        const appEnv = { APP_ENV: props.stage === STAGES.PROD ? 'production' : 'development' };

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
                ...appEnv,
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
                ...appEnv,
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

        // Per-model embedding config (chunkSize/chunkOverlap tokens), tunable
        // without a code deploy. PK=modelType, SK=modelName. Read at chunking
        // time by parse-and-chunk (realtime) and the notes accumulator (batch);
        // missing rows fall back to code defaults. Seed via
        // encoding-server/scripts/seed_model_registry.py.
        const embeddingModelRegistryTable = new dynamodb.Table(this, 'EmbeddingModelRegistryTable', {
            tableName: 'EmbeddingModelRegistry',
            partitionKey: { name: 'modelType', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'modelName', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN, // operator-managed config
        });
        const modelRegistryEnv = { EMBEDDING_MODEL_REGISTRY_TABLE: embeddingModelRegistryTable.tableName };

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
                ...appEnv,
                JOBLIB_TEMP_FOLDER: '/tmp',
                ...modelRegistryEnv,
                // API keys for hosted embedding providers (voyage/openai model types).
                // Only needed by semantic chunking here; sourced from the deploy environment.
                ...(process.env.VOYAGE_API_KEY ? { VOYAGE_API_KEY: process.env.VOYAGE_API_KEY } : {}),
                ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
            },
        });
        embeddingModelRegistryTable.grantReadData(this.parseAndChunkLambda);

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
                ...appEnv,
                JOBLIB_TEMP_FOLDER: '/tmp',
                // API keys for hosted embedding providers (voyage/openai model types)
                ...(process.env.VOYAGE_API_KEY ? { VOYAGE_API_KEY: process.env.VOYAGE_API_KEY } : {}),
                ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
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
                ...appEnv,
                ZILLIZ_ENDPOINT: props.zillizEndpoint,
                ZILLIZ_TOKEN: props.zillizToken,
                CUSTOMER_VECTOR_DB_CONFIG_TABLE: props.customerVectorDBConfigTableName,
                CUSTOMER_NOTES_TABLE: props.customerNotesTableName,
                INSTRUCTIONS_TABLE: props.instructionsTableName,
            },
        });

        // Expose cryptographic arrays perfectly mapping AWS natively safely
        customerVectorDBConfigTable.grantReadData(this.storeEmbeddingsLambda);
        // Store step marks NOTE rows synced and stamps INSTRUCTION rows with
        // their milvus_ids after insertion.
        customerNotesTable.grantReadWriteData(this.storeEmbeddingsLambda);
        instructionsTable.grantReadWriteData(this.storeEmbeddingsLambda);
        this.storeEmbeddingsLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'],
        }));

        /**
         * Voyage Batch pathway — customer-level batch embedding only: the
         * scheduled accumulator sweeps pending batch-mode notes into one Voyage
         * job, and a scheduled poller reconciles jobs when they complete.
         * Polling cost is flat (one poller per tick) regardless of how many
         * jobs are in flight. There is deliberately NO per-request batch route
         * through the ingestion pipeline — per-note batch jobs would cost the
         * full realtime compute plus batch bookkeeping.
         * Both Lambdas ride in the store-embeddings image (milvus-base) via cmd.
         */
        const voyageApiKeyEnv: Record<string, string> = props.voyageApiKey ? { VOYAGE_API_KEY: props.voyageApiKey } : {};

        // Tracking table of in-flight batch jobs; poller queries by status.
        this.voyageBatchJobsTable = new dynamodb.Table(this, 'VoyageBatchJobsTable', {
            tableName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-voyage-batch-jobs`,
            partitionKey: { name: 'batch_id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN, // stateful — never drop in-flight jobs
        });
        this.voyageBatchJobsTable.addGlobalSecondaryIndex({
            indexName: 'status-index',
            partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // Per-customer document store. Durable per-note/email objects live at
        // {customerId}/notes|emails/{id}.json; transient per-job staging lives
        // under _staging/{batchId}.json.
        const documentsEnv: Record<string, string> = {
            DOCUMENTS_BUCKET: props.customerDocumentsBucket.bucketName,
            STAGING_PREFIX: '_staging/',
            VOYAGE_BATCH_TABLE: this.voyageBatchJobsTable.tableName,
        };

        // Poller: reconciles all in-flight jobs; on completion downloads results
        // and stores them (reuses store logic → needs Zilliz creds + KMS + config).
        this.pollVoyageBatchesLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-poll-voyage-batches-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-poll-voyage-batches-lambda`,
            code: DockerImageCode.fromEcr(props.storeEmbeddingsRepo, {
                tagOrDigest: props.storeEmbeddingsImageTag || 'store-embeddings-latest',
                cmd: ['handlers.poll_voyage_batches_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                ...appEnv,
                ZILLIZ_ENDPOINT: props.zillizEndpoint,
                ZILLIZ_TOKEN: props.zillizToken,
                CUSTOMER_VECTOR_DB_CONFIG_TABLE: props.customerVectorDBConfigTableName,
                CUSTOMER_NOTES_TABLE: props.customerNotesTableName,
                ...voyageApiKeyEnv,
                ...documentsEnv,
            },
        });
        props.customerDocumentsBucket.grantReadWrite(this.pollVoyageBatchesLambda);
        this.voyageBatchJobsTable.grantReadWriteData(this.pollVoyageBatchesLambda);
        customerVectorDBConfigTable.grantReadData(this.pollVoyageBatchesLambda);
        // Poller marks notes synced (store step) and resets them on failure
        customerNotesTable.grantReadWriteData(this.pollVoyageBatchesLambda);
        this.pollVoyageBatchesLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'],
        }));

        // Accumulator: sweeps CustomerNotes for pending batch-mode notes, packs
        // them into one Voyage job per model, stages payload + records a row.
        // Table-driven bulk path — no per-note SQS/Step Functions.
        this.accumulateVoyageNotesLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-accumulate-voyage-notes-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-accumulate-voyage-notes-lambda`,
            code: DockerImageCode.fromEcr(props.storeEmbeddingsRepo, {
                tagOrDigest: props.storeEmbeddingsImageTag || 'store-embeddings-latest',
                cmd: ['handlers.accumulate_voyage_notes_lambda.handler'],
            }),
            memorySize: 1024,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                ...appEnv,
                CUSTOMER_NOTES_TABLE: props.customerNotesTableName,
                NOTES_EMBEDDING_STATUS_INDEX,
                ...modelRegistryEnv,
                ...voyageApiKeyEnv,
                ...documentsEnv,
            },
        });
        embeddingModelRegistryTable.grantReadData(this.accumulateVoyageNotesLambda);
        props.customerDocumentsBucket.grantReadWrite(this.accumulateVoyageNotesLambda);
        this.voyageBatchJobsTable.grantReadWriteData(this.accumulateVoyageNotesLambda);
        customerNotesTable.grantReadWriteData(this.accumulateVoyageNotesLambda);

        // Sweep on a schedule (less frequent than the poller — accumulate first,
        // then let the poller reconcile). Cadence tunable per cost/latency needs.
        new events.Rule(this, 'VoyageNotesAccumulateSchedule', {
            ruleName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-voyage-notes-accumulate`,
            schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
            targets: [new targets.LambdaFunction(this.accumulateVoyageNotesLambda)],
        });

        // Fire the poller on a fixed schedule — flat cost, decoupled from volume.
        new events.Rule(this, 'VoyageBatchPollSchedule', {
            ruleName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-voyage-batch-poll`,
            schedule: events.Schedule.rate(cdk.Duration.minutes(10)),
            targets: [new targets.LambdaFunction(this.pollVoyageBatchesLambda)],
        });

        /**
         * Create Collections Lambda
         * Explicit API endpoint handler for Zilliz collection generation
         */
        this.createCollectionsLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-collections-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-collections-lambda`,
            code: DockerImageCode.fromEcr(props.createCollectionsRepo, {
                tagOrDigest: props.createCollectionsImageTag || 'create-collections-latest',
                cmd: ['handlers.create_collections_lambda.handler'],
            }),
            memorySize: 512,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                ...appEnv,
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
         * Purge Vectors Lambda (PDF plan 3.9)
         * Deletes a customer's conversation vectors, or drops all their
         * collections, when genai-proxy-server purges a conversation or a
         * customer. Same image as create-collections with its own handler;
         * service-only: the handler accepts just the Auth0 client-credentials
         * tokens of the clients in PURGE_ALLOWED_CLIENT_IDS.
         */
        this.purgeVectorsLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-purge-vectors-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-purge-vectors-lambda`,
            code: DockerImageCode.fromEcr(props.createCollectionsRepo, {
                tagOrDigest: props.createCollectionsImageTag || 'create-collections-latest',
                cmd: ['handlers.purge_vectors_lambda.handler'],
            }),
            memorySize: 512,
            // API Gateway answers after 30 s anyway; the purge is idempotent and re-run by the proxy
            timeout: cdk.Duration.seconds(60),
            architecture: lambda.Architecture.X86_64,
            environment: {
                ...appEnv,
                ZILLIZ_ENDPOINT: props.zillizEndpoint,
                ZILLIZ_TOKEN: props.zillizToken,
                CUSTOMER_PROFILE_TABLE_NAME: props.customerProfileTableName,
                CUSTOMER_VECTOR_DB_CONFIG_TABLE: props.customerVectorDBConfigTableName,
                PURGE_ALLOWED_CLIENT_IDS: props.purgeAllowedClientIds || '',
            },
        });

        customerProfileTable.grantReadData(this.purgeVectorsLambda);
        customerVectorDBConfigTable.grantReadData(this.purgeVectorsLambda);
        this.purgeVectorsLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'],
        }));
    }
}
