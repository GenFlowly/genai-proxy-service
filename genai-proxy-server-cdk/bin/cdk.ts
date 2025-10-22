#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {DynamoDBStack} from '../lib/dynamodb-stack';
import {STAGES} from '@genflowly/cdk-commons';
import {EcsStack} from "../lib/ecs-stack";
import {EcrStack} from "../lib/ecr-stack";
import {
    OneTimeDeploymentPerStageStack
} from "../lib/oneTimeDeploymentPerStage-stack";
import {KmsStack} from "../lib/kms-stack";

const serviceName: string = 'gen-ai-proxy-service';
const stage: STAGES = STAGES.BETA;

const app = new cdk.App();

const targetStack = app.node.tryGetContext('target');

if (targetStack === 'BootstrapStack') {
    new OneTimeDeploymentPerStageStack(app, 'BootstrapStack', { stage });
}

if (targetStack === 'DynamoDBStack') {
    const dynamoDBStack = new DynamoDBStack(app, 'DynamoDBStack', {});
}

if (targetStack === 'EcrStack') {
    const ecrStack = new EcrStack(app, 'EcrStack', {serviceName, stage});
}

if (targetStack === 'KmsStack') {
    const kmsStack = new KmsStack(app, 'KmsStack', {serviceName, stage})
}

if (targetStack === 'EcsStack') {
    const dynamoDBStack = cdk.Stack.of(app).node.tryFindChild('DynamoDBStack');
    const ecrStack = cdk.Stack.of(app).node.tryFindChild('EcrStack');
    const kmsStack = cdk.Stack.of(app).node.tryFindChild('KmsStack');

    new EcsStack(app, 'EcsStack', {
        serviceName,
        stage,
        ecrRepo: (ecrStack as any)?.repository,
        dynamoDbTableList: (dynamoDBStack as any)?.dynamoDbTableList ?? [],
        kmsKey: (kmsStack as any)?.kmsKey,
    });
}


