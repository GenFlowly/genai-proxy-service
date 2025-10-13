import { aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  createDefaultDynamoDbTable,
  CreateTableProps,
} from '@genflowly/cdk-commons';

export interface DynamoDBStackProps extends cdk.StackProps {}

export class DynamoDBStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DynamoDBStackProps) {
    super(scope, id, props);

    const createUserTableProps: CreateTableProps = {
      tableName: 'User',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'oidp_provider', type: dynamodb.AttributeType.STRING },
    };

    createDefaultDynamoDbTable(this, createUserTableProps);
  }
}
