import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { STAGES } from '@genflowly/cdk-commons';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { FlyioIamStack } from '../lib/flyio-iam-stack';
import { KmsStack } from '../lib/kms-stack';
import { S3Stack } from '../lib/s3-stack';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The four stacks wired as bin/cdk.ts wires them. */
function synth(): Template {
    const app = new cdk.App();
    const stage = STAGES.BETA;
    const dynamo = new DynamoDBStack(app, 'gen-ai-proxy-service-DynamoDBStack', {});
    const kms = new KmsStack(app, 'gen-ai-proxy-service-KmsStack', { stage });
    const s3 = new S3Stack(app, 'gen-ai-proxy-service-S3Stack', { stage });
    const iam = new FlyioIamStack(app, 'gen-ai-proxy-service-FlyioIamStack', {
        stage,
        dynamoDbTableList: dynamo.dynamoDbTableList,
        kmsKey: kms.kmsKey,
        attachmentsBucket: s3.attachmentsBucket,
    });
    return Template.fromStack(iam);
}

const template = synth();

function logicalIdOfUser(userName: string): string {
    const users = template.findResources('AWS::IAM::User');
    const id = Object.keys(users).find((k) => users[k].Properties.UserName === userName);
    expect(id).toBeDefined();
    return id!;
}

const proxyUser = logicalIdOfUser('gen-ai-proxy-service-development-flyio-user');
const retrievalUser = logicalIdOfUser('gen-ai-proxy-service-development-retrieval-flyio-user');

/** Every statement of the managed policies attached to [user]. */
function statementsOf(user: string): any[] {
    return Object.values(template.findResources('AWS::IAM::ManagedPolicy'))
        .filter((p: any) => (p.Properties.Users ?? []).some((u: any) => u.Ref === user))
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

const asList = (v: any): any[] => (Array.isArray(v) ? v : [v]);

function actionsOf(user: string): string[] {
    return statementsOf(user).flatMap((s) => asList(s.Action));
}

function resourcesFor(user: string, action: string): any[] {
    return statementsOf(user).filter((s) => asList(s.Action).includes(action)).flatMap((s) => asList(s.Resource));
}

/** A resource rendered as text, so Fn::Join / Fn::ImportValue parts can be matched. */
const render = (resource: any): string => JSON.stringify(resource);

describe('FlyioIamStack', () => {
    test('the proxy and the retrieval server have separate users with their own keys', () => {
        // The proxy keeps the shared user's construct (same logical id, same key)
        expect(proxyUser.startsWith('FlyioServiceUser')).toBe(true);
        const keys = template.findResources('AWS::IAM::AccessKey');
        expect(Object.keys(keys).some((id) => id.startsWith('FlyioUserAccessKey'))).toBe(true);
        const owners = Object.values(keys).map((k: any) => k.Properties.UserName.Ref).sort();
        expect(owners).toEqual([proxyUser, retrievalUser].sort());
        const outputs = Object.keys(template.toJSON().Outputs);
        expect(outputs).toEqual(expect.arrayContaining([
            'ProxyAwsAccessKeyId', 'ProxyAwsSecretAccessKey', 'RetrievalAwsAccessKeyId', 'RetrievalAwsSecretAccessKey',
        ]));
    });

    test('the proxy may tag, read tags and delete customer objects', () => {
        for (const action of ['s3:PutObjectTagging', 's3:GetObjectTagging', 's3:DeleteObject']) {
            const resources = resourcesFor(proxyUser, action).map(render);
            expect(resources).toHaveLength(1);
            expect(resources[0]).toContain('/customers/*');
        }
        expect(actionsOf(proxyUser)).toEqual(expect.arrayContaining(['s3:GetObject', 's3:PutObject', 's3:ListBucket']));
    });

    test('the proxy may delete every version in the customer-documents bucket, referenced by name', () => {
        const list = resourcesFor(proxyUser, 's3:ListBucketVersions').map(render);
        const del = resourcesFor(proxyUser, 's3:DeleteObjectVersion').map(render);
        expect(list).toHaveLength(1);
        expect(list[0]).toContain(':s3:::genflowly-development-customer-documents"');
        expect(del).toHaveLength(1);
        expect(del[0]).toContain(':s3:::genflowly-development-customer-documents/*');
    });

    test('the retrieval server can read, write and tag but never delete', () => {
        const actions = actionsOf(retrievalUser);
        expect(actions).toEqual(expect.arrayContaining(['s3:GetObject', 's3:PutObject', 's3:PutObjectTagging', 's3:ListBucket']));
        expect(actions.filter((a) => a.startsWith('s3:') && a.includes('Delete'))).toEqual([]);
        expect(actions).not.toContain('s3:ListBucketVersions');
        // Not even through an inline policy
        const inline = Object.values(template.findResources('AWS::IAM::Policy'))
            .filter((p: any) => (p.Properties.Users ?? []).some((u: any) => u.Ref === retrievalUser))
            .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
            .flatMap((s: any) => asList(s.Action));
        expect(inline.filter((a: string) => a.startsWith('s3:'))).toEqual([]);
    });

    test('both users keep DynamoDB (PurgeJobs included) and KMS access', () => {
        for (const user of [proxyUser, retrievalUser]) {
            const resources = resourcesFor(user, 'dynamodb:PutItem').map(render);
            expect(resources.some((r) => r.includes('PurgeJobs'))).toBe(true);
            expect(resources.some((r) => r.includes('Message'))).toBe(true);
            const kms = Object.values(template.findResources('AWS::IAM::Policy'))
                .filter((p: any) => (p.Properties.Users ?? []).some((u: any) => u.Ref === user))
                .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
                .flatMap((s: any) => asList(s.Action));
            expect(kms).toEqual(expect.arrayContaining(['kms:Decrypt', 'kms:Encrypt']));
        }
    });
});
