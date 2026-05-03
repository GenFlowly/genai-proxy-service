#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { STAGES } from '@genflowly/cdk-commons';
import { EcsStack } from "../lib/ecs-stack";
import { EcrStack } from "../lib/ecr-stack";
import {
    OneTimeDeploymentPerStageStack
} from "../lib/oneTimeDeploymentPerStage-stack";
import { KmsStack } from "../lib/kms-stack";
import { RESOURCE_NAMES } from "../lib/constants";

const stageEnv = process.env.STAGE;
const stage: STAGES = stageEnv === 'production' ? STAGES.PROD : STAGES.BETA;
const rootDomain: string = 'genflowly.com';

const app = new cdk.App();

new OneTimeDeploymentPerStageStack(app, 'BootstrapStack', { stage })

const dynamoDBStack = new DynamoDBStack(app, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-DynamoDBStack`, {});
const ecrStack = new EcrStack(app, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-EcrStack`, { stage });
const kmsStack = new KmsStack(app, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-KmsStack`, { stage })
new EcsStack(app, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-EcsStack`, {
    stage,
    proxyEcrRepo: ecrStack.proxyRepository,
    retrievalEcrRepo: ecrStack.retrievalRepository,
    dynamoDbTableList: dynamoDBStack.dynamoDbTableList.filter(
        t => !['CustomerAgents', 'CustomerFlows'].includes(t.tableName)
    ),
    kmsKey: kmsStack.kmsKey,
    domainName: rootDomain,
    subdomain: 'api',
    certificateArn: cdk.Fn.importValue(`GenAIProxy-CertificateArn-${stage}`),
});

