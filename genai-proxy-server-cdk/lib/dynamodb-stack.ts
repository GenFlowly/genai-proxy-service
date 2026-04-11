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
                    indexName: 'customerIdIndex',
                    partitionKey: {
                        name: 'customerId',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'createdAt',
                        type: dynamodb.AttributeType.STRING,
                    },
                    projectionType: dynamodb.ProjectionType.INCLUDE,
                    nonKeyAttributes: ['conversationId', 'title', 'updatedAt'],
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

        const customerTable = createDefaultDynamoDbTable(this, createCustomerTableProps);
        const customerApiKeyTable = createDefaultDynamoDbTable(this, createCustomerApiKeyTableProps);
        const customerApiUsageTable = createDefaultDynamoDbTable(this, customerApiUsageTableProps);
        const conversationTable = createDefaultDynamoDbTable(this, conversationTableProps);
        const messageTable = createDefaultDynamoDbTable(this, messageTableProps);
        const customerPreferencesTable = createDefaultDynamoDbTable(this, customerPreferencesTableProps);
        const customerVectorDBConfigTable = createDefaultDynamoDbTable(this, customerVectorDBConfigTableProps);
        const customerSupabaseConfigTable = createDefaultDynamoDbTable(this, customerSupabaseConfigTableProps);
        const instructionsTable = createDefaultDynamoDbTable(this, instructionsTableProps);

        this.dynamoDbTableList.push(customerTable, customerApiKeyTable, customerApiUsageTable, conversationTable, messageTable, customerPreferencesTable, customerVectorDBConfigTable, customerSupabaseConfigTable, instructionsTable)
    }
}
