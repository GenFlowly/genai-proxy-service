import {aws_dynamodb as dynamodb} from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
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
            partitionKey: {name: 'sub', type: dynamodb.AttributeType.STRING},
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
            sortKey: {name: 'aiVendor', type: dynamodb.AttributeType.STRING},
        };

        const customerApiUsageTableProps: CreateTableProps = {
            tableName: 'CustomerAIUsage',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {name: 'usageDate', type: dynamodb.AttributeType.STRING},
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
        };

        const messageTableProps: CreateTableProps = {
            tableName: 'Message',
            partitionKey: {
                name: 'conversationId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {name: 'messageId', type: dynamodb.AttributeType.STRING},
        };

        const customerTable = createDefaultDynamoDbTable(this, createCustomerTableProps);
        const customerApiKeyTable = createDefaultDynamoDbTable(this, createCustomerApiKeyTableProps);
        const customerApiUsageTable = createDefaultDynamoDbTable(this, customerApiUsageTableProps);
        const conversationTable = createDefaultDynamoDbTable(this, conversationTableProps);
        const messageTable = createDefaultDynamoDbTable(this, messageTableProps);

        this.dynamoDbTableList.push(customerTable, customerApiKeyTable, customerApiUsageTable, conversationTable, messageTable)
    }
}
