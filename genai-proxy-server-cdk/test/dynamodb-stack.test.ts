import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DynamoDBStack } from '../lib/dynamodb-stack';

/* eslint-disable @typescript-eslint/no-explicit-any */

function synth(context: Record<string, string> = {}) {
    const app = new cdk.App({ context });
    const stack = new DynamoDBStack(app, 'DynamoDB', {});
    return { stack, template: Template.fromStack(stack) };
}

function table(template: Template, name: string): any {
    const found = Object.values(template.findResources('AWS::DynamoDB::Table'))
        .find((t: any) => t.Properties.TableName === name);
    expect(found).toBeDefined();
    return found;
}

function index(t: any, name: string): any {
    return (t.Properties.GlobalSecondaryIndexes ?? []).find((i: any) => i.IndexName === name);
}

describe('DynamoDBStack retention tables and indexes', () => {
    test('PurgeJobs is keyed by jobKey with a sparse pendingShard/dueAt index', () => {
        const purgeJobs = table(synth().template, 'PurgeJobs');
        expect(purgeJobs.Properties.KeySchema).toEqual([{ AttributeName: 'jobKey', KeyType: 'HASH' }]);
        expect(index(purgeJobs, 'pending-purge-index')).toEqual({
            IndexName: 'pending-purge-index',
            KeySchema: [
                { AttributeName: 'pendingShard', KeyType: 'HASH' },
                { AttributeName: 'dueAt', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
        });
        expect(purgeJobs.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    });

    test('Message gets the sparse claimPending index and the KEYS_ONLY customerIdIndex', () => {
        const message = table(synth().template, 'Message');
        expect(index(message, 'claimPendingIndex')).toEqual({
            IndexName: 'claimPendingIndex',
            KeySchema: [
                { AttributeName: 'claimPending', KeyType: 'HASH' },
                { AttributeName: 'createdAt', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'KEYS_ONLY' },
        });
        expect(index(message, 'customerIdIndex')).toEqual({
            IndexName: 'customerIdIndex',
            KeySchema: [
                { AttributeName: 'customerId', KeyType: 'HASH' },
                { AttributeName: 'createdAt', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'KEYS_ONLY' },
        });
        expect(message.Properties.AttributeDefinitions).toEqual(expect.arrayContaining([
            { AttributeName: 'claimPending', AttributeType: 'N' },
            { AttributeName: 'customerId', AttributeType: 'S' },
            { AttributeName: 'createdAt', AttributeType: 'S' },
        ]));
    });

    test('the first rollout adds one Message index at a time (CloudFormation adds one GSI per update)', () => {
        const message = table(synth({ messageGsiPhase: '1' }).template, 'Message');
        expect((message.Properties.GlobalSecondaryIndexes as any[]).map((i) => i.IndexName)).toEqual(['claimPendingIndex']);
    });

    test('PurgeJobs is in the table list the Fly IAM policy covers', () => {
        const { stack } = synth();
        expect(stack.dynamoDbTableList.map((t) => t.node.id)).toContain('PurgeJobs');
        expect(stack.dynamoDbTableList).toHaveLength(28);
    });
});
