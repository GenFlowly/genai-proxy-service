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
            tableName: 'Customer',
            partitionKey: {name: 'email', type: dynamodb.AttributeType.STRING},
            sortKey: {
                name: 'oidpProvider',
                type: dynamodb.AttributeType.STRING
            },
        };

        const createCustomerApiKeyTableProps: CreateTableProps = {
            tableName: 'CustomerApiKey',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {name: 'aiVendor', type: dynamodb.AttributeType.STRING},
        };

        const customerApiUsageTableProps: CreateTableProps = {
            tableName: 'CustomerUsage',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {name: 'usageDate', type: dynamodb.AttributeType.STRING},
        };

        const customerTable = createDefaultDynamoDbTable(this, createCustomerTableProps);
        const customerApiKeyTable = createDefaultDynamoDbTable(this, createCustomerApiKeyTableProps);
        const customerApiUsageTable = createDefaultDynamoDbTable(this, customerApiUsageTableProps);

        this.dynamoDbTableList.push(customerTable, customerApiKeyTable, customerApiUsageTable)
    }
}
