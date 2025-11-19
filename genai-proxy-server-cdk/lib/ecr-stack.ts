import * as cdk from "aws-cdk-lib";
import { STAGES } from "@genflowly/cdk-commons";
import { Construct } from "constructs";
import { EcsStackProps } from "./ecs-stack";
import { CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { IRepository, Repository } from "aws-cdk-lib/aws-ecr";
import { RESOURCE_NAMES } from "./constants";


export interface EcrStackProps extends cdk.StackProps {
    stage: STAGES;
}


export class EcrStack extends cdk.Stack {

    public readonly repository: IRepository;
    public readonly processingRepository: IRepository;

    constructor(scope: Construct, id: string, props: EcrStackProps) {
        super(scope, id, props);

        const repoName = `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-repo`;

        let importedRepo: IRepository | undefined;
        try {
            importedRepo = Repository.fromRepositoryName(this, `${repoName}-imported-id`, repoName);
        } catch (err) {
            importedRepo = undefined;
        }

        const newRepo = new Repository(this, `${repoName}-id`, {
            repositoryName: repoName,
            imageScanOnPush: true,
            lifecycleRules: [
                { maxImageCount: 5, description: 'Keep last 5 images only' },
            ],
            removalPolicy: RemovalPolicy.RETAIN,
        });

        this.repository = importedRepo ?? newRepo;

        new CfnOutput(this, 'EcrRepositoryUri', {
            value: this.repository.repositoryUri,
        });

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
