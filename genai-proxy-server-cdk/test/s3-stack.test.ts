import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { STAGES } from '@genflowly/cdk-commons';
import { S3Stack } from '../lib/s3-stack';

/* eslint-disable @typescript-eslint/no-explicit-any */

function bucket(context: Record<string, string> = {}): any {
    const app = new cdk.App({ context });
    const stack = new S3Stack(app, 'S3', { stage: STAGES.BETA });
    const buckets = Template.fromStack(stack).findResources('AWS::S3::Bucket');
    const [only] = Object.values(buckets);
    expect(Object.keys(buckets)).toHaveLength(1);
    return only;
}

function rules(context: Record<string, string> = {}): any[] {
    return bucket(context).Properties.LifecycleConfiguration.Rules;
}

function rule(id: string, context: Record<string, string> = {}): any {
    const found = rules(context).find((r) => r.Id === id);
    expect(found).toBeDefined();
    return found;
}

describe('S3Stack attachments bucket', () => {
    test('scratch expires after 7 days and derived after 30, by tag', () => {
        expect(rule('expire-scratch')).toMatchObject({
            Status: 'Enabled',
            ExpirationInDays: 7,
            TagFilters: [{ Key: 'retention', Value: 'scratch' }],
        });
        expect(rule('expire-derived')).toMatchObject({
            Status: 'Enabled',
            ExpirationInDays: 30,
            TagFilters: [{ Key: 'retention', Value: 'derived' }],
        });
    });

    test('pending expires after 7 days, but only once enabled with the context flag', () => {
        expect(rule('expire-pending')).toMatchObject({
            Status: 'Disabled',
            ExpirationInDays: 7,
            TagFilters: [{ Key: 'retention', Value: 'pending' }],
        });
        expect(rule('expire-pending', { enablePendingExpiry: 'true' })).toMatchObject({ Status: 'Enabled' });
        expect(rule('expire-pending', { enablePendingExpiry: 'false' })).toMatchObject({ Status: 'Disabled' });
    });

    test('incomplete multipart uploads are aborted after 1 day', () => {
        expect(rule('abort-incomplete-multipart-uploads')).toMatchObject({
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        });
    });

    test('no rule expires an untagged customers/{cid}/attachments/ object', () => {
        const expiring = rules({ enablePendingExpiry: 'true' }).filter(
            (r) => r.ExpirationInDays !== undefined || r.ExpirationDate !== undefined
        );
        expect(expiring).toHaveLength(3);
        for (const r of expiring) {
            expect(r.TagFilters?.length).toBeGreaterThan(0);
            expect(r.TagFilters.map((t: any) => t.Value)).not.toContain('kept');
        }
        expect(rules().map((r) => r.Id).sort()).toEqual([
            'abort-incomplete-multipart-uploads',
            'expire-derived',
            'expire-pending',
            'expire-scratch',
        ]);
    });

    test('the bucket stays unversioned, private and retained', () => {
        const b = bucket();
        expect(b.Properties.VersioningConfiguration).toBeUndefined();
        expect(b.UpdateReplacePolicy).toBe('Retain');
        expect(b.DeletionPolicy).toBe('Retain');
        expect(b.Properties.PublicAccessBlockConfiguration).toMatchObject({
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
        });
    });

    test('browser uploads may send the signed tagging header', () => {
        expect(bucket().Properties.CorsConfiguration.CorsRules).toEqual([
            expect.objectContaining({ AllowedHeaders: ['*'], AllowedMethods: ['PUT', 'GET', 'HEAD'] }),
        ]);
    });
});
