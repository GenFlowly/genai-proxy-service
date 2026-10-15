import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { CUSTOMER_DOCUMENTS_BUCKET_NAME, RESOURCE_NAMES } from './constants';
import { STAGES } from '@genflowly/cdk-commons';

export interface FlyioIamStackProps extends cdk.StackProps {
    stage: STAGES;
    dynamoDbTableList: ITable[];
    kmsKey: IKey;
    attachmentsBucket: IBucket;
}

/**
 * IAM users for the two Fly.io apps. The proxy server presigns uploads and
 * downloads, claims (tags) linked objects and purges deleted customers, so it
 * alone may delete. The retrieval server reads attachments and writes tagged
 * artifacts and scratch, and can delete nothing.
 */
export class FlyioIamStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FlyioIamStackProps) {
        super(scope, id, props);

        // The proxy server's user. This was the one user both apps shared: its
        // construct id and name are unchanged so its access key stays valid
        // while the retrieval server moves to its own user.
        const proxyUser = new iam.User(this, 'FlyioServiceUser', {
            userName: `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-flyio-user`,
        });

        const retrievalUser = new iam.User(this, 'RetrievalServerUser', {
            userName: `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-retrieval-flyio-user`,
        });

        // Grant DynamoDB read/write via a customer-managed policy attached to the users.
        // We used to call table.grantReadWriteData(flyioUser) per table, which appended
        // statements to the user's inline default policy. Inline user policies cap at
        // 2048 chars and we hit that ceiling as we added tables. Managed policies cap
        // at 6144 chars, so we consolidate every table + its indexes into one statement.
        const dynamoDbResources = props.dynamoDbTableList.flatMap((table) => [
            table.tableArn,
            `${table.tableArn}/index/*`,
        ]);
        new iam.ManagedPolicy(this, 'FlyioDynamoDbAccess', {
            users: [proxyUser, retrievalUser],
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

        const customerObjects = props.attachmentsBucket.arnForObjects('customers/*');

        // Proxy server: presigned PUT/GET (signed with these credentials, so the
        // user needs the actions the browser performs, tagging included), the
        // kept-object claim (tag reads/writes, copies), and the customer purge
        // (deletes). ListBucket lets HeadObject and listing distinguish 404 from 403.
        // Managed policy for the same inline-policy-size reason as DynamoDB above.
        new iam.ManagedPolicy(this, 'FlyioAttachmentsBucketAccess', {
            users: [proxyUser],
            statements: [
                new iam.PolicyStatement({
                    actions: ['s3:GetObject', 's3:PutObject'],
                    resources: [props.attachmentsBucket.arnForObjects('*')],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:PutObjectTagging', 's3:GetObjectTagging', 's3:DeleteObject'],
                    resources: [customerObjects],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:ListBucket'],
                    resources: [props.attachmentsBucket.bucketArn],
                }),
            ],
        });

        // Customer purge: every version of the customer's objects in the
        // encoding-server's versioned customer-documents bucket. That bucket is
        // defined in the encoding-server-cdk app, so it is referenced by name.
        const customerDocuments = s3.Bucket.fromBucketName(
            this, 'CustomerDocumentsBucket', CUSTOMER_DOCUMENTS_BUCKET_NAME(props.stage)
        );
        new iam.ManagedPolicy(this, 'ProxyCustomerDocumentsPurge', {
            users: [proxyUser],
            statements: [
                new iam.PolicyStatement({
                    actions: ['s3:ListBucketVersions'],
                    resources: [customerDocuments.bucketArn],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:DeleteObjectVersion'],
                    resources: [customerDocuments.arnForObjects('*')],
                }),
            ],
        });

        // Retrieval server: reads image bytes and documents, writes generated
        // artifacts and agent-fs scratch with a retention tag on the PUT (which
        // needs PutObjectTagging), lists for fs_list and for NoSuchKey vs 403.
        // No delete of any kind.
        new iam.ManagedPolicy(this, 'RetrievalAttachmentsBucketAccess', {
            users: [retrievalUser],
            statements: [
                new iam.PolicyStatement({
                    actions: ['s3:GetObject', 's3:PutObject'],
                    resources: [props.attachmentsBucket.arnForObjects('*')],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:PutObjectTagging'],
                    resources: [customerObjects],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:ListBucket'],
                    resources: [props.attachmentsBucket.bucketArn],
                }),
            ],
        });

        // Both services decrypt the customers' KMS-encrypted vendor keys
        props.kmsKey.grantEncryptDecrypt(proxyUser);
        props.kmsKey.grantEncryptDecrypt(retrievalUser);

        // Grant access to invoke Lambda functions
        proxyUser.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: ['*'], // Can be scoped down to specific lambda ARNs if known
        }));

        // Access keys, output so the deploy workflows can set them as Fly.io secrets
        const proxyAccessKey = new iam.AccessKey(this, 'FlyioUserAccessKey', { user: proxyUser });
        const retrievalAccessKey = new iam.AccessKey(this, 'RetrievalServerAccessKey', { user: retrievalUser });

        new cdk.CfnOutput(this, 'ProxyAwsAccessKeyId', {
            value: proxyAccessKey.accessKeyId,
            description: 'AWS_ACCESS_KEY_ID of the proxy server Fly.io app',
        });
        new cdk.CfnOutput(this, 'ProxyAwsSecretAccessKey', {
            value: proxyAccessKey.secretAccessKey.unsafeUnwrap(),
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
