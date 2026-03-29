import { aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    createDefaultDynamoDbTable,
    CreateTableProps,
    STAGES,
} from '@genflowly/cdk-commons';

export interface DynamoDBStackProps extends cdk.StackProps {
    readonly stage: STAGES;
}

export class DynamoDBStack extends cdk.Stack {
    public readonly dynamoDbTableList: dynamodb.Table[] = [];

    constructor(scope: Construct, id: string, props: DynamoDBStackProps) {
        super(scope, id, props);

        const customerVectorDBBackupContentTableProps: CreateTableProps = {
            tableName: 'CustomerVectorDBBackupContent',
            partitionKey: {
                name: 'customerId',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'dataId',
                type: dynamodb.AttributeType.STRING
            },
        };

        const customerVectorDBBackupContentTable = createDefaultDynamoDbTable(this, customerVectorDBBackupContentTableProps);

        this.dynamoDbTableList.push(customerVectorDBBackupContentTable);
    }
}
