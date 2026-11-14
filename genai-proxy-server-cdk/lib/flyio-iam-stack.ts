import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { RESOURCE_NAMES } from './constants';
import { STAGES } from '@genflowly/cdk-commons';

export interface FlyioIamStackProps extends cdk.StackProps {
    stage: STAGES;
    dynamoDbTableList: ITable[];
    kmsKey: IKey;
    attachmentsBucket: IBucket;
}

export class FlyioIamStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FlyioIamStackProps) {
        super(scope, id, props);

        // Create an IAM User for Fly.io to access AWS resources
        const flyioUser = new iam.User(this, 'FlyioServiceUser', {
            userName: `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-flyio-user`,
        });

        // Separate IAM user for the retrieval server's Fly app, so its
        // credentials are scoped to what it actually touches (DynamoDB, KMS,
        // attachments bucket) instead of sharing the proxy's user. Codifies
        // infrastructure already live in AWS — see the PurgeJobs note in
        // dynamodb-stack.ts.
        const retrievalServerUser = new iam.User(this, 'RetrievalServerUser', {
            userName: `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-retrieval-flyio-user`,
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
            users: [flyioUser, retrievalServerUser],
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

        // Attachments bucket access for the Fly.io services. Both the proxy server
        // (presigns PUT/GET for browser uploads) and the retrieval server (reads
        // image bytes for LLM calls) authenticate as this same user, so one grant
        // covers both. ListBucket lets HeadObject distinguish 404 from 403.
        // Managed policy for the same inline-policy-size reason as DynamoDB above.
        new iam.ManagedPolicy(this, 'FlyioAttachmentsBucketAccess', {
            users: [flyioUser],
            statements: [
                new iam.PolicyStatement({
                    actions: ['s3:GetObject', 's3:PutObject'],
                    resources: [props.attachmentsBucket.arnForObjects('*')],
                }),
                new iam.PolicyStatement({
                    // Tag/delete is deliberately limited to customer-owned
                    // keys — the purge pipeline tags and removes customer
                    // attachments but never touches other prefixes.
                    actions: ['s3:DeleteObject', 's3:GetObjectTagging', 's3:PutObjectTagging'],
                    resources: [props.attachmentsBucket.arnForObjects('customers/*')],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:ListBucket'],
                    resources: [props.attachmentsBucket.bucketArn],
                }),
            ],
        });

        // Attachments access for the retrieval server (generated artifacts +
        // reading image bytes for LLM calls), mirroring the proxy's policy
        // minus deletion.
        new iam.ManagedPolicy(this, 'RetrievalAttachmentsBucketAccess', {
            users: [retrievalServerUser],
            statements: [
                new iam.PolicyStatement({
                    actions: ['s3:GetObject', 's3:PutObject'],
                    resources: [props.attachmentsBucket.arnForObjects('*')],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:PutObjectTagging'],
                    resources: [props.attachmentsBucket.arnForObjects('customers/*')],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:ListBucket'],
                    resources: [props.attachmentsBucket.bucketArn],
                }),
            ],
        });

        // Content reports are emailed through the support topic, which belongs to
        // the separately deployed SupportStack, so it is referenced by name.
        new iam.ManagedPolicy(this, 'ProxySupportTopicPublish', {
            users: [flyioUser],
            statements: [
                new iam.PolicyStatement({
                    actions: ['sns:Publish'],
                    resources: [
                        `arn:${cdk.Aws.PARTITION}:sns:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-support-requests`,
                    ],
                }),
            ],
        });

        // The proxy's customer-documents purge worker lists and hard-deletes
        // object VERSIONS in the per-stage customer-documents bucket. That
        // bucket belongs to the encoding service's stacks, so it is referenced
        // by name rather than imported.
        const customerDocumentsBucketArn = `arn:${cdk.Aws.PARTITION}:s3:::genflowly-${props.stage}-customer-documents`;
        new iam.ManagedPolicy(this, 'ProxyCustomerDocumentsPurge', {
            users: [flyioUser],
            statements: [
                new iam.PolicyStatement({
                    actions: ['s3:ListBucketVersions'],
                    resources: [customerDocumentsBucketArn],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:DeleteObjectVersion'],
                    resources: [`${customerDocumentsBucketArn}/*`],
                }),
            ],
        });

        // Grant access to KMS key
        props.kmsKey.grantEncryptDecrypt(flyioUser);
        props.kmsKey.grantEncryptDecrypt(retrievalServerUser);

        // Grant access to invoke Lambda functions
        flyioUser.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: ['*'], // Can be scoped down to specific lambda ARNs if known
        }));

        // Create access keys for the users
        const accessKey = new iam.AccessKey(this, 'FlyioUserAccessKey', { user: flyioUser });
        const retrievalAccessKey = new iam.AccessKey(this, 'RetrievalServerAccessKey', { user: retrievalServerUser });

        // Output the credentials so they can be securely added to Fly.io.
        // The FlyioAws* pair are the legacy names the deploy workflows read
        // (and feed to BOTH Fly apps today); the Proxy*/Retrieval* names are
        // the per-app split the deployed stack already exposes — keep both
        // until the workflows move over.
        new cdk.CfnOutput(this, 'FlyioAwsAccessKeyId', {
            value: accessKey.accessKeyId,
            description: 'Set this as AWS_ACCESS_KEY_ID in Fly.io secrets',
        });

        new cdk.CfnOutput(this, 'FlyioAwsSecretAccessKey', {
            value: accessKey.secretAccessKey.unsafeUnwrap(), // Only outputs once at creation time
            description: 'Set this as AWS_SECRET_ACCESS_KEY in Fly.io secrets',
        });

        new cdk.CfnOutput(this, 'ProxyAwsAccessKeyId', {
            value: accessKey.accessKeyId,
            description: 'AWS_ACCESS_KEY_ID of the proxy server Fly.io app',
        });

        new cdk.CfnOutput(this, 'ProxyAwsSecretAccessKey', {
            value: accessKey.secretAccessKey.unsafeUnwrap(),
            description: 'AWS_SECRET_ACCESS_KEY of the proxy server Fly.io app',
        });

        new cdk.CfnOutput(this, 'RetrievalAwsAccessKeyId', {
            value: retrievalAccessKey.accessKeyId,
            description: 'AWS_ACCESS_KEY_ID of the retrieval server Fly.io app',
        });

        new cdk.CfnOutput(this, 'RetrievalAwsSecretAccessKey', {
            value: retrievalAccessKey.secretAccessKey.unsafeUnwrap(),
            description: 'AWS_SECRET_ACCESS_KEY of the retrieval server Fly.io app',
        });
    }
}
