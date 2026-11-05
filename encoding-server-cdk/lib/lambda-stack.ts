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
    // storeEmbeddingsRepo stays: the Voyage batch lambdas (accumulator +
    // poller) ride the store image via cmd, even though the store FUNCTION
    // itself was replaced by create-and-store.
    storeEmbeddingsRepo: ecr.IRepository;
    createAndStoreRepo: ecr.IRepository;
    createCollectionsRepo: ecr.IRepository;
    ingestionImageTag?: string;
    parseAndChunkImageTag?: string;
    storeEmbeddingsImageTag?: string;
    createAndStoreImageTag?: string;
    createCollectionsImageTag?: string;
    customerProfileTableName: string;
    customerVectorDBConfigTableName: string;
    customerNotesTableName: string;
    instructionsTableName: string;
    // Source tables the pipeline reads indexed text from: pipeline messages
    // carry ids only (encoding-server services/content_source.py).
    messageTableName: string;
    conversationTableName: string;
    customerMemoryTableName: string;
    // The proxy's registry of records not yet in the vector DB: the store
    // step deletes a record's row once its vectors are stored.
    vectorSyncPendingTableName: string;
    // Per-customer embedding (and vendor LLM) API keys — the proxy's
    // CustomerVendorApiKeys table, KMS-encrypted. Hosted embedding models
    // (voyage/openai) run exclusively on the customer's own key; there is no
    // platform-wide fallback.
    customerApiKeyTableName: string;
    /** Auth0 client ids allowed to call POST /purge-vectors (comma-separated; empty refuses all). */
    purgeAllowedClientIds?: string;
    // Cost and Usage settings pages: per-customer usage/cost rollup (write) and
    // embedding model pricing (read) — see genai-proxy-server's
    // UsageRollupRepository/ModelCatalogService for the owning side.
    customerApiUsageTableName: string;
    aiModelCatalogTableName: string;
}

export class LambdaStack extends cdk.Stack {

    public readonly ingestEmailLambda: lambda.Function;
    public readonly ingestNotesLambda: lambda.Function;
    public readonly parseAndChunkLambda: DockerImageFunction;
    public readonly createAndStoreLambda: DockerImageFunction;
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
        const messageTable = dynamodb.Table.fromTableName(this, 'MessageTable', props.messageTableName);
        const conversationTable = dynamodb.Table.fromTableName(this, 'ConversationTable', props.conversationTableName);
        const customerMemoryTable = dynamodb.Table.fromTableName(this, 'CustomerMemoryTable', props.customerMemoryTableName);
        const contentSourceEnv = {
            CUSTOMER_NOTES_TABLE: props.customerNotesTableName,
            MESSAGE_TABLE: props.messageTableName,
            CONVERSATION_TABLE: props.conversationTableName,
            INSTRUCTIONS_TABLE: props.instructionsTableName,
            CUSTOMER_MEMORY_TABLE: props.customerMemoryTableName,
        };
        const contentSourceTables = [customerNotesTable, messageTable, conversationTable, instructionsTable, customerMemoryTable];
        const vectorSyncPendingTable = dynamodb.Table.fromTableName(this, 'VectorSyncPendingTable', props.vectorSyncPendingTableName);
        const vectorSyncPendingEnv = { VECTOR_SYNC_PENDING_TABLE: props.vectorSyncPendingTableName };
        const customerApiKeyTable = dynamodb.Table.fromTableName(this, 'CustomerVendorApiKeysTable', props.customerApiKeyTableName);
        const customerApiKeyEnv = { CUSTOMER_API_KEY_TABLE: props.customerApiKeyTableName };
        const customerApiUsageTable = dynamodb.Table.fromTableName(this, 'CustomerApiUsageTable', props.customerApiUsageTableName);
        const aiModelCatalogTable = dynamodb.Table.fromTableName(this, 'AIModelCatalogTable', props.aiModelCatalogTableName);
        const usageTrackingEnv = {
            CUSTOMER_API_USAGE_TABLE: props.customerApiUsageTableName,
            AI_MODEL_CATALOG_TABLE: props.aiModelCatalogTableName,
        };

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
                ...customerApiKeyEnv,
                ...contentSourceEnv,
            },
        });
        embeddingModelRegistryTable.grantReadData(this.parseAndChunkLambda);
        contentSourceTables.forEach((table) => table.grant(this.parseAndChunkLambda, 'dynamodb:GetItem'));
        // Semantic chunking (only) embeds on the customer's own hosted-provider key.
        customerApiKeyTable.grantReadData(this.parseAndChunkLambda);
        this.parseAndChunkLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'],
        }));

        /**
         * Create-and-Store Lambda: embeds a Map-state batch and inserts it
         * into the vector DB in ONE invocation, so vectors never cross a Step
         * Functions state boundary (256KB payload cap —
         * States.DataLimitExceeded made messages over ~24K chars unembeddable).
         * Replaced the former create-embeddings + store-embeddings pair.
         */
        this.createAndStoreLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-and-store-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-and-store-lambda`,
            code: DockerImageCode.fromEcr(props.createAndStoreRepo, {
                tagOrDigest: props.createAndStoreImageTag || 'create-and-store-latest',
                cmd: ['handlers.create_and_store_lambda.handler'],
            }),
            memorySize: 3008,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                ...appEnv,
                JOBLIB_TEMP_FOLDER: '/tmp',
                ...customerApiKeyEnv,
                ...contentSourceEnv,
                ...vectorSyncPendingEnv,
                CUSTOMER_VECTOR_DB_CONFIG_TABLE: props.customerVectorDBConfigTableName,
                ...usageTrackingEnv,
            },
        });
        contentSourceTables.forEach((table) => table.grant(this.createAndStoreLambda, 'dynamodb:GetItem'));
        customerVectorDBConfigTable.grantReadData(this.createAndStoreLambda);
        // Embeds on the customer's own hosted-provider key (voyage/openai).
        customerApiKeyTable.grantReadData(this.createAndStoreLambda);
        // Store step marks NOTE rows synced and stamps INSTRUCTION rows with
        // their milvus_ids after insertion.
        customerNotesTable.grantReadWriteData(this.createAndStoreLambda);
        instructionsTable.grantReadWriteData(this.createAndStoreLambda);
        vectorSyncPendingTable.grant(this.createAndStoreLambda, 'dynamodb:DeleteItem');
        // Cost and Usage: writes per-customer embedding usage after each
        // embed call, reads AIModelCatalog to price it.
        customerApiUsageTable.grantReadWriteData(this.createAndStoreLambda);
        aiModelCatalogTable.grantReadData(this.createAndStoreLambda);
        this.createAndStoreLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'],
        }));

        // CloudFormation updates these downstream-first (create-and-store,
        // parse-and-chunk, ingest-notes) so no step receives a payload its
        // deployed version can't read: an older parse-and-chunk indexes an
        // empty string for an ids-only message and marks the note synced, and
        // an older create-and-store skips a chunk plan.
        this.parseAndChunkLambda.node.addDependency(this.createAndStoreLambda);
        this.ingestNotesLambda.node.addDependency(this.parseAndChunkLambda);

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
                CUSTOMER_VECTOR_DB_CONFIG_TABLE: props.customerVectorDBConfigTableName,
                CUSTOMER_NOTES_TABLE: props.customerNotesTableName,
                ...vectorSyncPendingEnv,
                ...customerApiKeyEnv,
                ...documentsEnv,
                ...usageTrackingEnv,
            },
        });
        props.customerDocumentsBucket.grantReadWrite(this.pollVoyageBatchesLambda);
        this.voyageBatchJobsTable.grantReadWriteData(this.pollVoyageBatchesLambda);
        customerVectorDBConfigTable.grantReadData(this.pollVoyageBatchesLambda);
        // Poller marks notes synced (store step) and resets them on failure
        customerNotesTable.grantReadWriteData(this.pollVoyageBatchesLambda);
        vectorSyncPendingTable.grant(this.pollVoyageBatchesLambda, 'dynamodb:DeleteItem');
        // Resolves the job's customer's Voyage key to poll/download their batch.
        customerApiKeyTable.grantReadData(this.pollVoyageBatchesLambda);
        // Cost and Usage: records the completed batch job's embedding usage
        // (job row already carries customer_id/model_name) against the
        // catalog's batch-discounted rate.
        customerApiUsageTable.grantReadWriteData(this.pollVoyageBatchesLambda);
        aiModelCatalogTable.grantReadData(this.pollVoyageBatchesLambda);
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
                ...customerApiKeyEnv,
                ...documentsEnv,
            },
        });
        embeddingModelRegistryTable.grantReadData(this.accumulateVoyageNotesLambda);
        props.customerDocumentsBucket.grantReadWrite(this.accumulateVoyageNotesLambda);
        this.voyageBatchJobsTable.grantReadWriteData(this.accumulateVoyageNotesLambda);
        customerNotesTable.grantReadWriteData(this.accumulateVoyageNotesLambda);
        // Resolves each pending note's customer's Voyage key before grouping.
        customerApiKeyTable.grantReadData(this.accumulateVoyageNotesLambda);
        this.accumulateVoyageNotesLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'],
        }));

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
