import * as cdk from "aws-cdk-lib";
import { CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { STAGES } from "@genflowly/cdk-commons";
import { Construct } from "constructs";
import { IRepository, Repository } from "aws-cdk-lib/aws-ecr";
import { RESOURCE_NAMES } from "./constants";


export interface EcrStackProps extends cdk.StackProps {
    stage: STAGES;
}


export class EcrStack extends cdk.Stack {

    public readonly proxyRepository: IRepository;
    public readonly retrievalRepository: IRepository;

    constructor(scope: Construct, id: string, props: EcrStackProps) {
        super(scope, id, props);

        const proxyRepoName = `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-repo`;
        const retrievalRepoName = `retrieval-server-${props.stage}-repo`;

        const removalPolicy = props.stage === STAGES.BETA ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

        this.proxyRepository = new Repository(this, `${proxyRepoName}-id`, {
            repositoryName: proxyRepoName,
            imageScanOnPush: true,
            lifecycleRules: [
                { maxImageCount: 5, description: 'Keep last 5 images only' },
            ],
            removalPolicy: removalPolicy,
        });

        this.retrievalRepository = new Repository(this, `${retrievalRepoName}-id`, {
            repositoryName: retrievalRepoName,
            imageScanOnPush: true,
            lifecycleRules: [
                { maxImageCount: 5, description: 'Keep last 5 images only' },
            ],
            removalPolicy: removalPolicy,
        });

        new CfnOutput(this, 'EcrProxyRepositoryUri', {
            value: this.proxyRepository.repositoryUri,
        });

        new CfnOutput(this, 'EcrRetrievalRepositoryUri', {
            value: this.retrievalRepository.repositoryUri,
        });
    }
}
