import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { RESOURCE_NAMES } from './constants';
import { STAGES } from '@genflowly/cdk-commons';

export interface FlyioIamStackProps extends cdk.StackProps {
    stage: STAGES;
    dynamoDbTableList: ITable[];
    kmsKey: IKey;
}

export class FlyioIamStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FlyioIamStackProps) {
        super(scope, id, props);

        // Create an IAM User for Fly.io to access AWS resources
        const flyioUser = new iam.User(this, 'FlyioServiceUser', {
            userName: `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-flyio-user`,
        });

        // Grant DynamoDB read/write via a customer-managed policy attached to the user.
        // We used to call table.grantReadWriteData(flyioUser) per table, which appended
        // statements to the user's inline default policy. Inline user policies cap at
        // 2048 chars and we hit that ceiling as we added tables. Managed policies cap
        // at 6144 chars, so we consolidate every table + its indexes into one statement.
        const dynamoDbResources = props.dynamoDbTableList.flatMap((table) => [
            table.tableArn,
            `${table.tableArn}/index/*`,
        ]);
        new iam.ManagedPolicy(this, 'FlyioDynamoDbAccess', {
            users: [flyioUser],
            statements: [
                new iam.PolicyStatement({
                    actions: [
                        'dynamodb:BatchGetItem',
                        'dynamodb:GetRecords',
                        'dynamodb:GetShardIterator',
                        'dynamodb:Query',
                        'dynamodb:GetItem',
                        'dynamodb:Scan',
                        'dynamodb:ConditionCheckItem',
                        'dynamodb:BatchWriteItem',
                        'dynamodb:PutItem',
                        'dynamodb:UpdateItem',
                        'dynamodb:DeleteItem',
                        'dynamodb:DescribeTable',
                    ],
                    resources: dynamoDbResources,
                }),
            ],
        });

        // Grant access to KMS key
        props.kmsKey.grantEncryptDecrypt(flyioUser);

        // Grant access to invoke Lambda functions
        flyioUser.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: ['*'], // Can be scoped down to specific lambda ARNs if known
        }));

        // Create access keys for the user
        const accessKey = new iam.AccessKey(this, 'FlyioUserAccessKey', { user: flyioUser });

        // Output the credentials so they can be securely added to Fly.io
        new cdk.CfnOutput(this, 'FlyioAwsAccessKeyId', {
            value: accessKey.accessKeyId,
            description: 'Set this as AWS_ACCESS_KEY_ID in Fly.io secrets',
        });

        new cdk.CfnOutput(this, 'FlyioAwsSecretAccessKey', {
            value: accessKey.secretAccessKey.unsafeUnwrap(), // Only outputs once at creation time
            description: 'Set this as AWS_SECRET_ACCESS_KEY in Fly.io secrets',
        });
    }
}
