#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { STAGES } from '@genflowly/cdk-commons';
import { SupportStack } from '../lib/support-stack';
import { RESOURCE_NAMES } from '../lib/constants';

// Its own CDK app, so support changes don't trigger the proxy workflows (see *-support-api.yml).
const stage: STAGES = process.env.STAGE === 'production' ? STAGES.PROD : STAGES.BETA;

const app = new cdk.App();

new SupportStack(app, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-SupportStack`, {
    stage,
    supportEmails: process.env.SUPPORT_EMAILS,
    auth0Domain: process.env.AUTH0_SPA_DOMAIN,
    auth0Audience: process.env.AUTH0_API_AUDIENCE,
});
