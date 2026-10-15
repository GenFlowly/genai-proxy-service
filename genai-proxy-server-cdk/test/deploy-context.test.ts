import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { STAGES } from '@genflowly/cdk-commons';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { S3Stack } from '../lib/s3-stack';

/* eslint-disable @typescript-eslint/no-explicit-any */

// What the deploy workflows actually synthesize: `cdk deploy` reads the
// context in cdk.json. The retention rollout is staged through two pins there
// (genai-proxy-server development.md, "Retention"); these tests fail when a pin
// changes so the change is made on purpose, with its preconditions met.
const context = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8')).context;

describe('cdk.json deploy context', () => {
    test('pins the Message table to one new index per deploy (claimPendingIndex first)', () => {
        // Remove the pin only after both stages have deployed claimPendingIndex;
        // that deploy then adds customerIdIndex.
        const stack = new DynamoDBStack(new cdk.App({ context }), 'DynamoDB', {});
        const message: any = Object.values(Template.fromStack(stack).findResources('AWS::DynamoDB::Table'))
            .find((t: any) => t.Properties.TableName === 'Message');
        expect(message.Properties.GlobalSecondaryIndexes.map((i: any) => i.IndexName)).toEqual(['claimPendingIndex']);
    });

    test('keeps the pending expiry rule off', () => {
        // Flip only after the claim is live in production and the claim
        // backfill has run in both stages.
        const stack = new S3Stack(new cdk.App({ context }), 'S3', { stage: STAGES.PROD });
        const [bucket]: any[] = Object.values(Template.fromStack(stack).findResources('AWS::S3::Bucket'));
        const pending = bucket.Properties.LifecycleConfiguration.Rules.find((r: any) => r.Id === 'expire-pending');
        expect(pending.Status).toBe('Disabled');
    });
});
