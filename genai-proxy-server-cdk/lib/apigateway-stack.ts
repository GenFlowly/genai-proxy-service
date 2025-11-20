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
    ingestionLambda: lambda.IFunction;
}

export class ApiGatewayStack extends cdk.Stack {

    public readonly api: apigatewayv2.HttpApi;

    constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
        super(scope, id, props);

        // Auth0 configuration
        const auth0Domain = 'dev-abh5z7416lwy3xhv.us.auth0.com';
        const auth0Issuer = `https://${auth0Domain}/`;
        const auth0Audience = process.env.AUTH0_API_AUDIENCE || 'https://genflowly-beta';

        // Create JWT Authorizer for Auth0
        const authorizer = new HttpJwtAuthorizer('Auth0Authorizer', auth0Issuer, {
            jwtAudience: [auth0Audience],
        });

        // Create HTTP API (v2) with CORS support
        this.api = new apigatewayv2.HttpApi(this, 'WorkflowApi', {
            apiName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-apigw`,
            description: 'Email encoding service API with Auth0 JWT authentication',
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

        // Create Lambda integration
        const integration = new HttpLambdaIntegration(
            'IngestionIntegration',
            props.ingestionLambda
        );

        // Add route with JWT authorization
        this.api.addRoutes({
            path: '/sync',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: integration,
            authorizer: authorizer,
        });

        // API endpoint output
        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-apigw-ApiEndpoint`, {
            value: this.api.url || '',
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
            description: 'Auth0 API Audience (set AUTH0_API_AUDIENCE env var)',
        });
    }
}
