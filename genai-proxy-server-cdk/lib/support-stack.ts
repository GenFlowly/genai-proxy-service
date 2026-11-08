import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { STAGES } from '@genflowly/cdk-commons';
import { RESOURCE_NAMES } from './constants';

export interface SupportStackProps extends cdk.StackProps {
    stage: STAGES;
    /** Comma-separated addresses that receive every support request. */
    supportEmails?: string;
    /** Auth0 domain that issues the apps' access tokens, e.g. auth.genflowly.com. */
    auth0Domain?: string;
    /** The access tokens' audience: the stage's API identifier the web and iOS apps request. */
    auth0Audience?: string;
}

/** The sites the support form runs on. Browsers on any other origin are refused. */
const PRODUCTION_ORIGINS = ['https://genflowly.com'];
const DEVELOPMENT_ORIGINS = ['https://development.genflowly.com', 'http://localhost:3000'];

/**
 * POST /support: a signed-in user's support request, emailed to the support
 * inbox through SNS. API Gateway checks the Auth0 access token before the
 * Lambda runs; the stage throttle bounds what a single account can send.
 */
export class SupportStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: SupportStackProps) {
        super(scope, id, props);

        const prefix = `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}`;

        if (!props.auth0Domain || !props.auth0Audience) {
            throw new Error(
                'AUTH0_SPA_DOMAIN and AUTH0_API_AUDIENCE must be set: POST /support only accepts signed-in requests.'
            );
        }
        const authorizer = new HttpJwtAuthorizer(
            'Auth0Authorizer',
            `https://${props.auth0Domain}/`,
            { jwtAudience: [props.auth0Audience] }
        );

        const topic = new sns.Topic(this, 'SupportRequestsTopic', {
            topicName: `${prefix}-support-requests`,
            // Shown as the sender's name on the emails.
            displayName: 'Unbiase AI Support',
            enforceSSL: true,
        });

        const emails = (props.supportEmails || '')
            .split(',')
            .map((email) => email.trim())
            .filter((email) => email.length > 0);
        if (emails.length === 0) {
            cdk.Annotations.of(this).addWarning(
                'SUPPORT_EMAILS is empty: support requests will reach no one.'
            );
        }
        emails.forEach((email) =>
            topic.addSubscription(new subscriptions.EmailSubscription(email))
        );

        const logGroup = new logs.LogGroup(this, 'SupportRequestLogs', {
            logGroupName: `/aws/lambda/${prefix}-support-request`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const fn = new lambda.Function(this, 'SupportRequestFunction', {
            functionName: `${prefix}-support-request`,
            runtime: lambda.Runtime.PYTHON_3_12,
            architecture: lambda.Architecture.ARM_64,
            handler: 'handler.handler',
            code: lambda.Code.fromAsset(
                path.join(__dirname, '..', 'lambda', 'support'),
                { exclude: ['tests', '__pycache__', '*.pyc'] }
            ),
            memorySize: 128,
            timeout: cdk.Duration.seconds(10),
            logGroup,
            environment: {
                TOPIC_ARN: topic.topicArn,
                STAGE: props.stage,
            },
        });
        topic.grantPublish(fn);

        const api = new apigatewayv2.HttpApi(this, 'SupportApi', {
            apiName: `${prefix}-support-api`,
            description: 'Support form requests, published to the support SNS topic',
            createDefaultStage: false,
            corsPreflight: {
                allowOrigins:
                    props.stage === STAGES.PROD ? PRODUCTION_ORIGINS : DEVELOPMENT_ORIGINS,
                allowMethods: [apigatewayv2.CorsHttpMethod.POST],
                allowHeaders: ['Authorization', 'Content-Type'],
                maxAge: cdk.Duration.days(1),
            },
        });

        new apigatewayv2.HttpStage(this, 'DefaultStage', {
            httpApi: api,
            stageName: '$default',
            autoDeploy: true,
            throttle: { rateLimit: 1, burstLimit: 5 },
        });

        api.addRoutes({
            path: '/support',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: new HttpLambdaIntegration('SupportRequestIntegration', fn),
            authorizer,
        });

        // Read by the web app's deploy workflows.
        new cdk.CfnOutput(this, 'SupportRequestUrl', {
            value: `${api.apiEndpoint}/support`,
            description: 'POST endpoint for support requests',
        });
    }
}
