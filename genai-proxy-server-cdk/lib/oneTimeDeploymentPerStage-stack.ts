import * as cdk from 'aws-cdk-lib';
import { Construct } from "constructs";
import { setupGitHubActionsForCDKDeployment, STAGES } from "@genflowly/cdk-commons";

export interface IamStackProps extends cdk.StackProps {
  stage: STAGES;
}

export class OneTimeDeploymentPerStageStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    const ghAccessKey = setupGitHubActionsForCDKDeployment(props.stage, this)

    new cdk.CfnOutput(this, 'AWS_ACCESS_KEY_ID', {
      value: ghAccessKey.ref,
    });

    new cdk.CfnOutput(this, 'AWS_SECRET_ACCESS_KEY', {
      value: ghAccessKey.attrSecretAccessKey,
    });

    console.log("Add the above secrets to repository settings > Security > Actions");


  }

}