#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { STAGES } from '@genflowly/cdk-commons';
import { FlyioIamStack } from "../lib/flyio-iam-stack";
import {
    OneTimeDeploymentPerStageStack
} from "../lib/oneTimeDeploymentPerStage-stack";
import { KmsStack } from "../lib/kms-stack";
import { RESOURCE_NAMES } from "../lib/constants";

const stageEnv = process.env.STAGE;
const stage: STAGES = stageEnv === 'production' ? STAGES.PROD : STAGES.BETA;

const app = new cdk.App();

new OneTimeDeploymentPerStageStack(app, 'BootstrapStack', { stage })

const dynamoDBStack = new DynamoDBStack(app, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-DynamoDBStack`, {});
const kmsStack = new KmsStack(app, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-KmsStack`, { stage })

new FlyioIamStack(app, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-FlyioIamStack`, {
    stage,
    dynamoDbTableList: dynamoDBStack.dynamoDbTableList,
    kmsKey: kmsStack.kmsKey,
});

