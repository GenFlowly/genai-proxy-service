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

        const customerTable = createDefaultDynamoDbTable(this, createCustomerTableProps);
        const customerApiKeyTable = createDefaultDynamoDbTable(this, createCustomerApiKeyTableProps);
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
        const usernameLookupTable = createDefaultDynamoDbTable(this, usernameLookupTableProps);

        this.dynamoDbTableList.push(
            customerTable, customerApiKeyTable, customerApiUsageTable,
            conversationTable, messageTable, customerPreferencesTable,
            customerVectorDBConfigTable, customerSupabaseConfigTable, instructionsTable,
            customerGraphNodesTable, customerGraphsTable,
            customerToolCredentialsTable, sharedInstructionsTable, sharedConversationsTable,
            usernameLookupTable
        );
    }
}
