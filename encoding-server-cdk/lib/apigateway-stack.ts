import * as cdk from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGES } from '@genflowly/cdk-commons';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { RESOURCE_NAMES } from './constants';

export interface ApiGatewayStackProps extends cdk.StackProps {
    stage: STAGES;
    ingestEmailLambda: lambda.IFunction;
    ingestNotesLambda: lambda.IFunction;
    createCollectionsLambda: lambda.IFunction;
    auth0Domain: string;
}

export class ApiGatewayStack extends cdk.Stack {

    public readonly api: apigatewayv2.HttpApi;

    constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
        super(scope, id, props);

        // Auth0 configuration
        const auth0Domain = props.auth0Domain;
        const auth0Issuer = `https://${auth0Domain}/`;

        // Create HTTP API (v2) with CORS support
        // We create the API first to get the endpoint URL for the audience
        this.api = new apigatewayv2.HttpApi(this, 'WorkflowApi', {
            apiName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-apigw`,
            description: 'Email encoding service API with Auth0 JWT authentication',
            createDefaultStage: false, // We will create a named stage
            corsPreflight: {
                allowOrigins: ['*'],
                allowMethods: [
                    apigatewayv2.CorsHttpMethod.GET,
                    apigatewayv2.CorsHttpMethod.POST,
                    apigatewayv2.CorsHttpMethod.OPTIONS,
                ],
                allowHeaders: [
                    'Content-Type',
                    'Authorization',
                    'X-Amz-Date',
                    'X-Api-Key',
                    'X-Amz-Security-Token',
                ],
                maxAge: cdk.Duration.days(1),
            },
        });

        // Create a named stage
        new apigatewayv2.HttpStage(this, 'Stage', {
            httpApi: this.api,
            stageName: props.stage,
            autoDeploy: true,
        });

        // Use the API endpoint as the audience
        // Note: api.apiEndpoint returns the base URL (e.g., https://xyz.execute-api.us-east-1.amazonaws.com)
        // This matches the user's request.
        const auth0Audience = this.api.apiEndpoint;

        // Create JWT Authorizer for Auth0
        const authorizer = new HttpJwtAuthorizer('Auth0Authorizer', auth0Issuer, {
            jwtAudience: [
                auth0Audience, 
                'https://genflowly-beta',
                'https://api-development.genflowly.com',
                'https://api-production.genflowly.com'
            ],
        });

        // Create Lambda integration
        const emailIntegration = new HttpLambdaIntegration(
            'IngestEmailIntegration',
            props.ingestEmailLambda
        );

        // Add route with JWT authorization
        this.api.addRoutes({
            path: '/encode-email',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: emailIntegration,
            authorizer: authorizer,
        });

        const ingestNotesIntegration = new HttpLambdaIntegration(
            'IngestNotesIntegration',
            props.ingestNotesLambda
        );

        this.api.addRoutes({
            path: '/encode-notes',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: ingestNotesIntegration,
            authorizer: authorizer,
        });

        // Long-term user memories share the notes ingest handler — the payload's
        // dataType (MEMORY) selects the processor/collection downstream.
        this.api.addRoutes({
            path: '/encode-memories',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: ingestNotesIntegration,
            authorizer: authorizer,
        });

        // Conversation exchanges share the same ingest handler — the payload's
        // dataType (CONVERSATION) selects the processor/collection downstream.
        this.api.addRoutes({
            path: '/encode-conversations',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: ingestNotesIntegration,
            authorizer: authorizer,
        });

        // Instructions share the same ingest handler — the payload's
        // dataType (INSTRUCTION) selects the processor/collection downstream.
        this.api.addRoutes({
            path: '/encode-instructions',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: ingestNotesIntegration,
            authorizer: authorizer,
        });

        const createCollectionsIntegration = new HttpLambdaIntegration(
            'CreateCollectionsIntegration',
            props.createCollectionsLambda
        );

        this.api.addRoutes({
            path: '/create-collections',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: createCollectionsIntegration,
            authorizer: authorizer,
        });


        // API endpoint output
        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-apigw-ApiEndpoint`, {
            value: `${this.api.apiEndpoint}/${props.stage}`, // Include stage in the output URL for convenience
            description: 'API Gateway endpoint URL',
        });

        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-apigw-Auth0Domain`, {
            value: auth0Domain,
            description: 'Auth0 Domain for JWT verification',
        });

        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-apigw-Auth0Issuer`, {
            value: auth0Issuer,
            description: 'Auth0 Issuer URL',
        });

        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-apigw-Auth0Audience`, {
            value: auth0Audience,
            description: 'Auth0 API Audience',
        });
    }
}
