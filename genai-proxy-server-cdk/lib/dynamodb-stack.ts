import { aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    createDefaultDynamoDbTable,
    CreateTableProps,
} from '@genflowly/cdk-commons';

export interface DynamoDBStackProps extends cdk.StackProps {
}

export class DynamoDBStack extends cdk.Stack {

    public readonly dynamoDbTableList: dynamodb.Table[] = []

    constructor(scope: Construct, id: string, props: DynamoDBStackProps) {
        super(scope, id, props);

        const createCustomerTableProps: CreateTableProps = {
            tableName: 'CustomerProfile',
            partitionKey: { name: 'sub', type: dynamodb.AttributeType.STRING },
            sortKey: {
                name: 'client',
                type: dynamodb.AttributeType.STRING
            },
            globalSecondaryIndexes: [
                {
                    indexName: 'customerIdIndex',
                    partitionKey: {
                        name: 'customerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        const createCustomerApiKeyTableProps: CreateTableProps = {
            tableName: 'CustomerVendorApiKeys',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: { name: 'aiVendor', type: dynamodb.AttributeType.STRING },
        };

        // System-wide (not per-customer) AI vendor API keys, managed from the
        // admin panel. PK=aiVendor only, so the proxy can fetch the key for a
        // vendor with a single O(1) GetItem. apiKey is stored KMS-encrypted.
        const systemVendorApiKeyTableProps: CreateTableProps = {
            tableName: 'SystemVendorApiKeys',
            partitionKey: {
                name: 'aiVendor',
                type: dynamodb.AttributeType.STRING
            },
        };

        // Per-model metadata (max output/input token limits) refreshed daily by
        // the proxy from the vendors' model APIs using the system keys.
        // PK=aiVendor, SK=model.
        const aiModelCatalogTableProps: CreateTableProps = {
            tableName: 'AIModelCatalog',
            partitionKey: {
                name: 'aiVendor',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: { name: 'model', type: dynamodb.AttributeType.STRING },
        };

        // Per-customer usage/cost rollup backing the Cost and Usage settings
        // pages. Provisioned ahead of an earlier attempt at this feature that
        // never shipped — the table was empty, so its key schema is reused
        // rather than replaced. usageDate is NOT a bare date: it is
        // "{YYYY-MM-DD}#{category}#{dim2}#{dim3}" (category = llm|embedding|
        // vector_db|web_search; dim2/dim3 = vendor/model, or opType, or
        // searchDepth), so one bounded Query per customer per date range
        // ("usageDate BETWEEN from AND to~") returns every category/vendor/
        // model/op-type combination in range — no GSI, no conversation
        // fan-out. See genai-proxy-server/repository/UsageRollupRepository.kt.
        const customerApiUsageTableProps: CreateTableProps = {
            tableName: 'CustomerAIUsage',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: { name: 'usageDate', type: dynamodb.AttributeType.STRING },
        };

        // Admin-configurable per-unit rates for the two usage categories with
        // no real per-request vendor price (Vector DB ops, Web Search
        // credits) — priced at READ time, unlike AIModelCatalog which prices
        // LLM/embedding usage at write time. PK=category, SK=rateKey.
        const usageRateCardTableProps: CreateTableProps = {
            tableName: 'UsageRateCard',
            partitionKey: {
                name: 'category',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: { name: 'rateKey', type: dynamodb.AttributeType.STRING },
        };

        const conversationTableProps: CreateTableProps = {
            tableName: 'Conversation',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'conversationId',
                type: dynamodb.AttributeType.STRING
            },
            globalSecondaryIndexes: [

                {
                    // Enables paginated listing of all conversations for a customer,
                    // sorted newest-first by createdAt.
                    indexName: 'customerIdIndexV2',
                    partitionKey: {
                        name: 'customerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'createdAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.INCLUDE,
                    nonKeyAttributes: ['conversationId', 'title', 'updatedAt', 'archivedAt'],
                },
                {
                    // Paginated listing ordered by last activity: updatedAt is
                    // bumped on every message write, so this index keeps the
                    // history sidebar sorted by most recently updated.
                    indexName: 'customerIdUpdatedAtIndex',
                    partitionKey: {
                        name: 'customerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'updatedAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.INCLUDE,
                    nonKeyAttributes: ['conversationId', 'title', 'createdAt', 'archivedAt'],
                },
                {
                    // Lookup a conversation by id alone, needed to serve requests
                    // from users who have the conversation shared with them and
                    // therefore don't know the owner's customerId.
                    indexName: 'conversationIdIndex',
                    partitionKey: {
                        name: 'conversationId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
                // CloudFormation permits only ONE GSI creation per stack update:
                // the two indexes below must reach an environment in two
                // sequential deploys (deploy with pinnedIndex first, then add
                // projectIndex), and the proxy-server code that queries them
                // ships only after both are ACTIVE.
                {
                    // Sparse: pinnedAt exists only while a conversation is pinned,
                    // so this index contains exactly the pinned set — presence is
                    // the flag, and the sort key yields newest-pinned-first without
                    // an in-memory sort. Serves GET /conversations/pinned without
                    // reading (and post-filtering) the customer's entire
                    // conversation partition.
                    indexName: 'pinnedIndex',
                    partitionKey: {
                        name: 'customerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'pinnedAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.INCLUDE,
                    nonKeyAttributes: [
                        'conversationId',
                        'title',
                        'createdAt',
                        'updatedAt',
                        'archivedAt',
                        'projectId',
                        'parentConversationId',
                        'vendors',
                    ],
                },
                {
                    // Sparse: only project-assigned conversations carry projectId.
                    // Serves project-scoped listing/unassignment (project delete)
                    // without reading the whole customer partition. KEYS_ONLY
                    // projects the base keys (customerId, conversationId), which
                    // is all the delete path needs.
                    indexName: 'projectIndex',
                    partitionKey: {
                        name: 'projectId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'updatedAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.KEYS_ONLY,
                },
            ],
        };

        const messageTableProps: CreateTableProps = {
            tableName: 'Message',
            partitionKey: {
                name: 'conversationId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
            globalSecondaryIndexes: [
                {
                    // Sparse worklist of messages pending a claim, oldest
                    // first (only rows with claimPending set appear). Part of
                    // the already-deployed purge/claim infra — see the
                    // PurgeJobs note below.
                    indexName: 'claimPendingIndex',
                    partitionKey: {
                        name: 'claimPending',
                        type: dynamodb.AttributeType.NUMBER,
                    },
                    sortKey: {
                        name: 'createdAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.KEYS_ONLY,
                },
            ],
        };

        const customerPreferencesTableProps: CreateTableProps = {
            tableName: 'CustomerPreferences',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
        };

        const customerVectorDBConfigTableProps: CreateTableProps = {
            tableName: 'CustomerVectorDBConfig',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
        };

        // Per-customer, per-embedding-vendor list of models the customer's key
        // can actually embed, discovered by probing (EmbeddingModelCatalogService
        // in the proxy). PK = customerId, SK = vendor. A sentinel row
        // (customerId = "__SWEEP__") holds the weekly-sweep lease.
        const customerEmbeddingModelsTableProps: CreateTableProps = {
            tableName: 'CustomerEmbeddingModels',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: { name: 'vendor', type: dynamodb.AttributeType.STRING },
        };

        // Deprecated: the customer-BYO-Supabase-as-vector-DB feature is fully
        // removed from every service. This table is intentionally retained in
        // the stack for now — removing it requires a two-phase CloudFormation
        // migration (FlyioIamStack imports its ARN via a cross-stack export, so
        // the export can't be deleted in the same deploy that drops the table).
        // It is unused and PAY_PER_REQUEST, so it costs nothing while idle.
        const customerSupabaseConfigTableProps: CreateTableProps = {
            tableName: 'CustomerSupabaseConfig',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
        };

        const instructionsTableProps: CreateTableProps = {
            tableName: 'Instructions',
            partitionKey: {
                name: 'instructionId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: { name: 'version', type: dynamodb.AttributeType.NUMBER },
            globalSecondaryIndexes: [
                {
                    indexName: 'creatorIndex',
                    partitionKey: {
                        name: 'creator',
                        type: dynamodb.AttributeType.STRING
                    },
                    sortKey: {
                        name: 'version',
                        type: dynamodb.AttributeType.NUMBER
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
                {
                    indexName: 'creatorIndexV2',
                    partitionKey: {
                        name: 'creator',
                        type: dynamodb.AttributeType.STRING
                    },
                    sortKey: {
                        name: 'version',
                        type: dynamodb.AttributeType.NUMBER
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                }
            ],
        };

        // Versioned graph nodes. PK=nodeId, SK=version (Number).
        // version=0 is always the current/live item and includes customerId for GSI indexing.
        // version=1,2,... are immutable history snapshots and omit customerId (sparse GSI).
        // This means the GSI only surfaces current-state items, never history.
        const customerGraphNodesTableProps: CreateTableProps = {
            tableName: 'CustomerGraphNodes',
            partitionKey: {
                name: 'nodeId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'version',
                type: dynamodb.AttributeType.NUMBER,
            },
            globalSecondaryIndexes: [
                {
                    // Lists current-state nodes for a customer (sparse: only v=0 items have customerId).
                    indexName: 'customerIdIndex',
                    partitionKey: {
                        name: 'customerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'createdAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        // Versioned graphs. Same PK=graphId, SK=version pattern as CustomerGraphNodes.
        const customerGraphsTableProps: CreateTableProps = {
            tableName: 'CustomerGraphs',
            partitionKey: {
                name: 'graphId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'version',
                type: dynamodb.AttributeType.NUMBER,
            },
            globalSecondaryIndexes: [
                {
                    // Lists current-state graphs for a customer (sparse: only v=0 items have customerId).
                    indexName: 'customerIdIndex',
                    partitionKey: {
                        name: 'customerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'createdAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        // Per-customer tool credentials.
        // PK=customerId, SK=toolType ("WEB_SEARCH", "CODE_EXECUTOR", "DATABASE_QUERY",
        //   "FILE_READER", "EMAIL", "CALENDAR").
        // credentials: KMS-encrypted JSON blob (shape is tool-specific).
        // authType: "api_key" | "oauth2" — determines how the proxy handles token refresh.
        // For oauth2 tools the blob also contains refresh_token, access_token, access_token_expiry.
        const customerToolCredentialsTableProps: CreateTableProps = {
            tableName: 'CustomerToolCredentials',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'toolType',
                type: dynamodb.AttributeType.STRING,
            },
        };

        // Per-customer declarative HTTP tools ("bring your own tool").
        // PK=customerId, SK=name (the model-facing tool name, ^[a-z][a-z0-9_]{2,63}$)
        //   — name-as-sort-key makes per-customer uniqueness a schema property.
        // description/parameters: what the model sees; parameters is a JSON string
        //   holding a restricted, non-nested JSON Schema object.
        // provider: "http" today — the seam value, "mcp" later.
        // request: JSON string call template. Its url's scheme+host are literal
        //   (placeholders rejected there), so a prompt-injected argument can never
        //   redirect the call to another host.
        // credentialRef: SK into CustomerToolCredentials, or "". This row holds NO
        //   secrets, ever — credential values stay KMS-encrypted in that table.
        // responseTransform: JSON string ({mode, path, maxChars}).
        // status: "draft" | "active" | "disabled" — only "active" is ever bound.
        // version: bumped on every save. origin/originRef: "manual" | "openapi" plus
        //   the spec URL that produced the row, for audit.
        const customerToolsTableProps: CreateTableProps = {
            tableName: 'CustomerTools',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'name',
                type: dynamodb.AttributeType.STRING,
            },
        };

        const sharedInstructionsTableProps: CreateTableProps = {
            tableName: 'SharedInstructions',
            partitionKey: {
                name: 'sharedWithCustomerId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'instructionId',
                type: dynamodb.AttributeType.STRING,
            },
            globalSecondaryIndexes: [
                {
                    indexName: 'instructionIdIndex',
                    partitionKey: {
                        name: 'instructionId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'sharedWithCustomerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        const sharedConversationsTableProps: CreateTableProps = {
            tableName: 'SharedConversations',
            partitionKey: {
                name: 'sharedWithCustomerId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'conversationId',
                type: dynamodb.AttributeType.STRING,
            },
            globalSecondaryIndexes: [
                {
                    indexName: 'conversationIdIndex',
                    partitionKey: {
                        name: 'conversationId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'sharedWithCustomerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        // Tracks how many distinct conversations each (customerId, instructionId) pair
        // has been used in, plus the timestamp of the most recent use.
        // PK=customerId, SK=instructionId.
        const instructionUsageTableProps: CreateTableProps = {
            tableName: 'InstructionUsage',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'instructionId',
                type: dynamodb.AttributeType.STRING,
            },
        };

        // Deduplication set — records which (conversationId, instructionId) pairs have
        // already been counted for a given customer, preventing double-counting when
        // a user sends multiple messages in the same conversation with the same persona.
        // PK=customerId, SK=convInstKey ("<conversationId>#<instructionId>").
        const instructionUsageSeenTableProps: CreateTableProps = {
            tableName: 'InstructionUsageSeen',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'convInstKey',
                type: dynamodb.AttributeType.STRING,
            },
        };

        const usernameLookupTableProps: CreateTableProps = {
            tableName: 'UsernameLookup',
            partitionKey: {
                name: 'username',
                type: dynamodb.AttributeType.STRING,
            },
            globalSecondaryIndexes: [
                {
                    indexName: 'recordTypeIndex',
                    partitionKey: {
                        name: 'recordType',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'username',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        const customerNotesTableProps: CreateTableProps = {
            tableName: 'CustomerNotes',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'noteKey',
                type: dynamodb.AttributeType.STRING
            },
            // Sparse index: only notes awaiting/undergoing batch embedding carry
            // `embedding_status`, so this index holds just the work queue and
            // shrinks to near-empty as the encoding-server accumulator drains it.
            globalSecondaryIndexes: [
                {
                    indexName: 'embedding-status-index',
                    partitionKey: {
                        name: 'embedding_status',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        // Long-term memories the system has learned about a customer from
        // conversations and notes. PK=customerId, SK=memoryId ("MEM#<uuid>" for
        // memory items; "META#..." items carry per-conversation extraction
        // bookkeeping and are filtered out of listings by key prefix).
        const customerMemoryTableProps: CreateTableProps = {
            tableName: 'CustomerMemory',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'memoryId',
                type: dynamodb.AttributeType.STRING,
            },
            // Sparse work queue (same pattern as CustomerNotes'
            // embedding-status-index): only "META#PENDING#<conversationId>"
            // rows carry `pendingShard` (constant "PENDING"), so this index
            // holds exactly the extraction jobs awaiting a run/retry and the
            // proxy's reconciler drains it by dueAt. It shrinks to near-empty
            // in steady state.
            globalSecondaryIndexes: [
                {
                    indexName: 'pending-extraction-index',
                    partitionKey: {
                        name: 'pendingShard',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'dueAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        // Maps a request type (e.g. INSTRUCTION_PERSONA) to the agent graph
        // that serves it. PK=scope ("SYSTEM" for the global defaults, a
        // customerId for future per-customer overrides), SK=requestType, so
        // resolution is a single O(1) GetItem per scope.
        const requestAgentMapTableProps: CreateTableProps = {
            tableName: 'RequestAgentMap',
            partitionKey: {
                name: 'scope',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'requestType',
                type: dynamodb.AttributeType.STRING,
            },
        };

        const customerDeveloperApiKeyTableProps: CreateTableProps = {
            tableName: 'CustomerDeveloperApiKeys',
            // SHA-256 hash of the key is the lookup key; the key itself is stored KMS-encrypted
            partitionKey: {
                name: 'keyHash',
                type: dynamodb.AttributeType.STRING
            },
            globalSecondaryIndexes: [
                {
                    indexName: 'customerIdIndex',
                    partitionKey: {
                        name: 'customerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        // Admin-curated pre-made nodes for the graph editor palette.
        const nodePresetsTableProps: CreateTableProps = {
            tableName: 'NodePresets',
            partitionKey: {
                name: 'presetId',
                type: dynamodb.AttributeType.STRING,
            },
        };

        // Customer-owned projects grouping conversations in the history
        // sidebar. PK=customerId, SK=projectId. No GSI: every access path
        // (list, get, rename, delete) already carries the authenticated
        // customerId. Conversations reference a project via a plain projectId
        // attribute on their Conversation row.
        const customerProjectsTableProps: CreateTableProps = {
            tableName: 'CustomerProjects',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'projectId',
                type: dynamodb.AttributeType.STRING,
            },
        };

        // Pending customer-document purge jobs (PK jobKey = one job; the
        // worker discovers due jobs via the pending-purge-index GSI instead
        // of a table scan). This table — plus the retrieval-server IAM user
        // and purge policies in flyio-iam-stack.ts — codifies infrastructure
        // that is already live in AWS ahead of its feature branch landing:
        // without it, every CD run wedges trying to delete the in-use
        // PurgeJobs ARN export (CloudFormation refuses while the deployed
        // FlyioIamStack imports it; see failed run 38835870063). Reconcile
        // with the purge feature's branch when it merges.
        const purgeJobsTableProps: CreateTableProps = {
            tableName: 'PurgeJobs',
            partitionKey: {
                name: 'jobKey',
                type: dynamodb.AttributeType.STRING,
            },
            globalSecondaryIndexes: [
                {
                    indexName: 'pending-purge-index',
                    partitionKey: {
                        name: 'pendingShard',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'dueAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
        };

        const customerTable = createDefaultDynamoDbTable(this, createCustomerTableProps);
        const customerApiKeyTable = createDefaultDynamoDbTable(this, createCustomerApiKeyTableProps);
        const systemVendorApiKeyTable = createDefaultDynamoDbTable(this, systemVendorApiKeyTableProps);
        const aiModelCatalogTable = createDefaultDynamoDbTable(this, aiModelCatalogTableProps);
        const customerApiUsageTable = createDefaultDynamoDbTable(this, customerApiUsageTableProps);
        const conversationTable = createDefaultDynamoDbTable(this, conversationTableProps);
        const messageTable = createDefaultDynamoDbTable(this, messageTableProps);
        const customerPreferencesTable = createDefaultDynamoDbTable(this, customerPreferencesTableProps);
        const customerVectorDBConfigTable = createDefaultDynamoDbTable(this, customerVectorDBConfigTableProps);
        const customerEmbeddingModelsTable = createDefaultDynamoDbTable(this, customerEmbeddingModelsTableProps);
        const customerSupabaseConfigTable = createDefaultDynamoDbTable(this, customerSupabaseConfigTableProps);
        const instructionsTable = createDefaultDynamoDbTable(this, instructionsTableProps);
        const customerGraphNodesTable = createDefaultDynamoDbTable(this, customerGraphNodesTableProps);
        const customerGraphsTable = createDefaultDynamoDbTable(this, customerGraphsTableProps);
        const customerToolCredentialsTable = createDefaultDynamoDbTable(this, customerToolCredentialsTableProps);
        const customerToolsTable = createDefaultDynamoDbTable(this, customerToolsTableProps);
        const sharedInstructionsTable = createDefaultDynamoDbTable(this, sharedInstructionsTableProps);
        const sharedConversationsTable = createDefaultDynamoDbTable(this, sharedConversationsTableProps);
        const instructionUsageTable = createDefaultDynamoDbTable(this, instructionUsageTableProps);
        const instructionUsageSeenTable = createDefaultDynamoDbTable(this, instructionUsageSeenTableProps);
        const usernameLookupTable = createDefaultDynamoDbTable(this, usernameLookupTableProps);
        const customerNotesTable = createDefaultDynamoDbTable(this, customerNotesTableProps);
        const customerDeveloperApiKeyTable = createDefaultDynamoDbTable(this, customerDeveloperApiKeyTableProps);
        const requestAgentMapTable = createDefaultDynamoDbTable(this, requestAgentMapTableProps);
        const customerMemoryTable = createDefaultDynamoDbTable(this, customerMemoryTableProps);
        const nodePresetsTable = createDefaultDynamoDbTable(this, nodePresetsTableProps);
        const customerProjectsTable = createDefaultDynamoDbTable(this, customerProjectsTableProps);
        const purgeJobsTable = createDefaultDynamoDbTable(this, purgeJobsTableProps);
        const usageRateCardTable = createDefaultDynamoDbTable(this, usageRateCardTableProps);

        this.dynamoDbTableList.push(
            customerTable, customerApiKeyTable, systemVendorApiKeyTable, aiModelCatalogTable, customerApiUsageTable,
            conversationTable, messageTable, customerPreferencesTable,
            customerVectorDBConfigTable, customerEmbeddingModelsTable, customerSupabaseConfigTable, instructionsTable,
            customerGraphNodesTable, customerGraphsTable,
            customerToolCredentialsTable, customerToolsTable, sharedInstructionsTable, sharedConversationsTable,
            instructionUsageTable, instructionUsageSeenTable,
            usernameLookupTable, customerNotesTable, customerDeveloperApiKeyTable,
            requestAgentMapTable, customerMemoryTable, nodePresetsTable, customerProjectsTable,
            purgeJobsTable, usageRateCardTable
        );
    }
}
