import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cdk from "aws-cdk-lib";
import { STAGES } from "@genflowly/cdk-commons";
import { RESOURCE_NAMES } from "./constants";

export interface KmsStackProps extends cdk.StackProps {
    stage: STAGES;
}
export class KmsStack extends Stack {
    public readonly kmsKey: kms.Key;

    constructor(scope: Construct, id: string, props: KmsStackProps) {
        super(scope, id, props);

        this.kmsKey = new kms.Key(this, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-key`, {
            enableKeyRotation: true,
            alias: `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-vendor-api-key-encryption-key`,
            description: 'KMS key for encrypting user API keys stored in DynamoDB',
        });

        new CfnOutput(this, 'KmsKeyArnOutput', {
            value: this.kmsKey.keyArn,
            exportName: 'KMSKeyArn',
        });
    }
}
