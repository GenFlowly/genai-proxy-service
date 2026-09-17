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

        const customerApiUsageTableProps: CreateTableProps = {
            tableName: 'CustomerAIUsage',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: { name: 'usageDate', type: dynamodb.AttributeType.STRING },
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
            ],
        };

        const messageTableProps: CreateTableProps = {
            tableName: 'Message',
            partitionKey: {
                name: 'conversationId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
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

        const customerTable = createDefaultDynamoDbTable(this, createCustomerTableProps);
        const customerApiKeyTable = createDefaultDynamoDbTable(this, createCustomerApiKeyTableProps);
        const systemVendorApiKeyTable = createDefaultDynamoDbTable(this, systemVendorApiKeyTableProps);
        const aiModelCatalogTable = createDefaultDynamoDbTable(this, aiModelCatalogTableProps);
        const customerApiUsageTable = createDefaultDynamoDbTable(this, customerApiUsageTableProps);
        const conversationTable = createDefaultDynamoDbTable(this, conversationTableProps);
        const messageTable = createDefaultDynamoDbTable(this, messageTableProps);
        const customerPreferencesTable = createDefaultDynamoDbTable(this, customerPreferencesTableProps);
        const customerVectorDBConfigTable = createDefaultDynamoDbTable(this, customerVectorDBConfigTableProps);
        const customerSupabaseConfigTable = createDefaultDynamoDbTable(this, customerSupabaseConfigTableProps);
        const instructionsTable = createDefaultDynamoDbTable(this, instructionsTableProps);
        const customerGraphNodesTable = createDefaultDynamoDbTable(this, customerGraphNodesTableProps);
        const customerGraphsTable = createDefaultDynamoDbTable(this, customerGraphsTableProps);
        const customerToolCredentialsTable = createDefaultDynamoDbTable(this, customerToolCredentialsTableProps);
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

        this.dynamoDbTableList.push(
            customerTable, customerApiKeyTable, systemVendorApiKeyTable, aiModelCatalogTable, customerApiUsageTable,
            conversationTable, messageTable, customerPreferencesTable,
            customerVectorDBConfigTable, customerSupabaseConfigTable, instructionsTable,
            customerGraphNodesTable, customerGraphsTable,
            customerToolCredentialsTable, sharedInstructionsTable, sharedConversationsTable,
            instructionUsageTable, instructionUsageSeenTable,
            usernameLookupTable, customerNotesTable, customerDeveloperApiKeyTable,
            requestAgentMapTable, customerMemoryTable, nodePresetsTable
        );
    }
}
