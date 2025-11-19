import * as cdk from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGES } from '@genflowly/cdk-commons';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { RESOURCE_NAMES } from './constants';

export interface ApiGatewayStackProps extends cdk.StackProps {
    stage: STAGES;
    ingestionLambda: lambda.IFunction;
}

export class ApiGatewayStack extends cdk.Stack {

    public readonly api: apigateway.RestApi;

    constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
        super(scope, id, props);

        this.api = new apigateway.RestApi(this, 'WorkflowApi', {
            restApiName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-apigw`,
            deployOptions: {
                stageName: props.stage,
            },
        });

        const integration = new apigateway.LambdaIntegration(props.ingestionLambda, {
            proxy: true,
        });

        const syncResource = this.api.root.addResource('sync');
        syncResource.addMethod('POST', integration);

        new CfnOutput(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-apigw-ApiEndpoint`, {
            value: this.api.url,
        });
    }
}
