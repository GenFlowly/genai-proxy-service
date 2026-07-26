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

        // Grant access to DynamoDB tables
        props.dynamoDbTableList.forEach((table) => {
            table.grantReadWriteData(flyioUser);
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
