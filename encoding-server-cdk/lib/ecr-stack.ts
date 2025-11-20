import * as cdk from "aws-cdk-lib";
import { STAGES } from "@genflowly/cdk-commons";
import { Construct } from "constructs";
import { CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { IRepository, Repository } from "aws-cdk-lib/aws-ecr";
import { RESOURCE_NAMES } from "./constants";

export interface EcrStackProps extends cdk.StackProps {
    stage: STAGES;
}

export class EcrStack extends cdk.Stack {

    public readonly processingRepository: IRepository;

    constructor(scope: Construct, id: string, props: EcrStackProps) {
        super(scope, id, props);

        this.processingRepository = new Repository(this, 'ProcessingLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-repo`,
            removalPolicy: RemovalPolicy.RETAIN,
            lifecycleRules: [{ maxImageCount: 5 }],
        });

        new CfnOutput(this, 'ProcessingRepoUri', {
            value: this.processingRepository.repositoryUri,
        });

    }
}
