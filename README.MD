# Application website - https://genflowly.com


## Section 1: Structure 
### 1. genai-proxy-server
Kotlin app that acts as the core API backend. Hosted on **Fly.io** (`genai-proxy-server-<stage>`).
### 2. genai-proxy-server-cdk
AWS CDK code that manages the persistent data and security infrastructure in AWS (DynamoDB tables, KMS encryption keys, and programmatic IAM access users for GitHub Actions and Fly.io).
### 3. genai-react-app
React Front end that lets you interact with the application. Hosted on Netlify.
### 4. retrieval-server (Sidecar)
Python AI/ML service running Uvicorn that handles vector embeddings and retrieval. Hosted as a private internal service on **Fly.io** (`genai-retrieval-server-<stage>`).
### 5. encoding-server
Python AWS lambdas that do chunking, encoding, and storing in vector DB.
### 6. encoding-server-cdk
CDK code that creates infrastructure for `encoding-server` in AWS for `development` and `production` stages.
### 7. encoding-library
Common abstractions related to embeddings in Python.

## Section 2: How to setup and deploy

### 1. AWS Setup (Database, KMS & IAM Layer)
1. Create an AWS account.
2. Go to IAM and create a temporary administrative User or set up your local AWS profile credentials (`aws configure --profile production`).
3. Go to `genai-proxy-server-cdk` and install dependencies: `npm install`.
4. **Bootstrap AWS CDK v2** (Required once per AWS account/region):
   ```bash
   AWS_PROFILE=production STAGE=development npx aws-cdk@latest bootstrap aws://<YOUR_AWS_ACCOUNT_ID>/us-east-1
   ```
5. Deploy the CDK stacks to provision DynamoDB, KMS, and IAM Users:
   ```bash
   AWS_PROFILE=production STAGE=development npx aws-cdk@latest deploy --all
   ```
6. After `BootstrapStack` deploys, note down the printed `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` outputs. These are the deployment user credentials required for your GitHub Actions secrets.
7. Similarly, repeat steps 4-5 for `encoding-server-cdk` if deploying lambda infrastructure.

### 2. Fly.io Setup (Compute & Apps)
1. Install Fly.io CLI and authenticate:
   ```bash
   brew install flyctl
   flyctl auth login
   ```
2. Create the application containers for your stage (e.g., `development`):
   ```bash
   flyctl apps create genai-proxy-server-development
   flyctl apps create genai-retrieval-server-development
   ```
3. Allocate dedicated public IP addresses for the proxy server:
   ```bash
   flyctl ips allocate-v4 -a genai-proxy-server-development
   flyctl ips allocate-v6 -a genai-proxy-server-development
   ```
4. Check your assigned IP addresses at any time:
   ```bash
   flyctl ips list -a genai-proxy-server-development
   ```
5. Register your subdomain for SSL/TLS certificate creation in Fly.io:
   ```bash
   flyctl certs add api-development.genflowly.com -a genai-proxy-server-development
   ```

### 3. Cloudflare Setup (DNS & WAF)
1. In your Cloudflare Dashboard, select your domain (`genflowly.com`).
2. **Remove legacy records**: If you have any old CNAME records for `api-development` pointing to AWS ECS or load balancers, delete them.
3. **Add Fly.io DNS Records**:
   - Create an **A Record**: Name = `api-development`, Target = `your-fly-ipv4-address`, **Proxied = ON** (Orange Cloud ☁️).
   - Create an **AAAA Record**: Name = `api-development`, Target = `your-fly-ipv6-address`, **Proxied = ON** (Orange Cloud ☁️).
4. **⚠️ Critical SSL Setting**: Navigate to **SSL/TLS > Overview** in Cloudflare and set the encryption mode to **Full (Strict)** or **Full**. *(If left on "Flexible", Cloudflare and Fly.io will enter an infinite redirect loop).*
5. Check certificate validation progress in Fly.io:
   ```bash
   flyctl certs check api-development.genflowly.com -a genai-proxy-server-development
   ```

### 4. Netlify Setup (Frontend)
1. Create a Netlify account and upload/deploy `genai-react-app`.
2. In Netlify Account Settings, generate a "Personal Access Token" without expiration (`NETLIFY_AUTH_TOKEN`).
3. In your Netlify Site Settings, copy the Site ID (`NETLIFY_SITE_ID`).

### 5. Auth0 Setup (Authentication)
1. Create an Auth0 account and set up a Single Page Application (SPA).
2. Set Allowed Callback, Logout, Web Origins, and CORS URLs to your stage frontend URLs (e.g., `https://development.genflowly.com`).
3. Create an API identifier matching your backend endpoint (e.g., `https://api-development.genflowly.com`).
4. **Authorize Client Access**: In your Auth0 Dashboard > **Applications > APIs** > select your API > click **Machine to Machine Applications** (or **Application Access** tab) > find your SPA Application and toggle it **Authorized (ON)**.
5. **Enable Refresh Tokens**: In your API Settings tab, scroll down to **Access Settings** and check **Allow Offline Access** (required for `offline_access` scope). Without this, no refresh token is issued and users are logged out as soon as the access token expires.
6. **Configure Session Persistence** (users stay logged in for 30 days when idle, indefinitely while active). In **Applications** > your SPA Application > **Settings**:
   1. **Refresh Token Rotation**: enable rotation and set **Rotation Overlap Period** to `30` seconds. The overlap prevents a network retry or multi-tab race (which reuses a just-rotated token) from being flagged as token theft, which would revoke the whole session.
   2. **Refresh Token Expiration** — order matters, since the Idle lifetime must be less than the Maximum:
      1. First, disable **Maximum Refresh Token Lifetime** (allowed once rotation is enabled — Auth0 requires SPAs to have rotation or expiration, but not both). If your plan does not allow disabling it, set it to `31557600` (1 year).
      2. Then set **Idle Refresh Token Lifetime** to `2592000` (30 days).
   3. With rotation enabled, every silent token refresh issues a new refresh token and resets the idle clock — so active users are never logged out, and idle users keep their session for 30 days.
   4. Repeat for both the development and production SPA Applications (and **Allow Offline Access** on both APIs).

   Note: Access Token lifetime (API > **Token Expiration**) and **ID Token Expiration** (Application Settings) only control how often the SDK performs a silent refresh; they do not affect how long users stay logged in.
7. Note down the API Audience, Client ID, and Domain for GitHub Actions secrets.


### 6. Github Actions CI/CD Setup
Go to your GitHub Repository > **Settings** > **Secrets and variables** > **Actions** and add the following repository secrets:
1. `FLY_API_TOKEN`: Generated via `flyctl tokens create deploy -x 999999h`
2. `AWS_ACCESS_KEY_ID`: From `BootstrapStack` output (for CDK CI/CD deployments)
3. `AWS_SECRET_ACCESS_KEY`: From `BootstrapStack` output
4. `AWS_REGION`: e.g., `us-east-1`
5. `AUTH0_API_AUDIENCE`
6. `AUTH0_SPA_CLIENT_ID`
7. `AUTH0_SPA_DOMAIN`
8. `NETLIFY_AUTH_TOKEN`
9. `NETLIFY_SITE_ID`
10. `ZILLIZ_ENDPOINT`
11. `ZILLIZ_TOKEN`

When you push to the `development` branch, GitHub Actions will automatically:
- Deploy any DynamoDB/KMS schema updates via AWS CDK.
- Fetch runtime AWS credentials from `FlyioIamStack` and inject them securely as Fly.io secrets into both `genai-proxy-server-<stage>` and `genai-retrieval-server-<stage>`.
- Build and deploy both backend applications to Fly.io!

### 7. Milvus Setup
1. Create a Zilliz Cloud account and get your endpoint and API token (`ZILLIZ_ENDPOINT`, `ZILLIZ_TOKEN`).


### 8. API Gateway & Custom Domain Setup (AWS to Cloudflare)
*Note: You will be creating two separate CNAME records in Cloudflare during this process. The first is a validation record to prove domain ownership to AWS (must be DNS Only / Gray Cloud). The second is the permanent routing record for live traffic (should be Proxied / Orange Cloud).*

To connect your AWS API Gateway URLs to your custom domain DNS in Cloudflare, follow these steps:

1. **Request an SSL Certificate in AWS (ACM):**
   - Go to AWS Certificate Manager (ACM) in your deployment region.
   - Click "Request a certificate", select "Public certificate", and enter your subdomain (e.g., `api-encode.genflowly.com`).
   - Select "DNS validation" and confirm.
   - Copy the CNAME name and CNAME value provided by ACM.

2. **Record 1: Validate Certificate in Cloudflare (Ownership Proof):**
   - Go to Cloudflare DNS settings for your domain.
   - Add a new **CNAME record** using the details copied from ACM:
     - **Name:** The CNAME Name provided by ACM (e.g., `_xxxxxxxxxxxxxxxxxxxx.api-encode`).
     - **Target:** The CNAME Value provided by ACM (e.g., `_xxxxxxxxxxxxxxxxxxxx.xxxxxxxxxx.acm-validations.aws.`).
   - **Crucial Setting - DNS Only (Gray Cloud):** You MUST set the Proxy status to **DNS only** (Gray Cloud). If Proxied, Cloudflare will hide the validation string and AWS will fail to verify ownership.
   - Wait a few minutes until the certificate status in ACM changes to "Issued".

3. **Create Custom Domain in API Gateway (TLS & Security Policies):**
   - Go to the API Gateway console in AWS.
   - Navigate to **Custom domain names** and click **Create**.
   - Enter your domain name (e.g., `api-encode.genflowly.com`).
   - Select **Regional** for the endpoint type (HTTP APIs only support Regional endpoints).
   - **Certificate:** Choose the ACM certificate you just validated.
   - **Security Policy:** Select **TLS_1_2** (this is the recommended minimum for modern security and supports both TLS 1.2 and TLS 1.3). HTTP APIs strictly require this minimum policy.
   - **Mutual TLS (mTLS) Authentication (Optional):** If your architecture demands that the client strictly authenticates itself via a certificate (e.g., service-to-service communication), you can enable mTLS here. You will need to provide an S3 URI pointing to your Truststore `.pem` file containing your trusted root Certificate Authorities. *Note: If enabling mTLS, Cloudflare proxying may interfere unless properly configured to pass client certificates, so you may need to set Cloudflare to DNS Only (Gray Cloud).*
   - Click Create.

4. **Configure API Mappings:**
   - In the Custom domain details, go to the **API mappings** tab.
   - Click **Configure API mappings** -> **Add new mapping**.
   - Select your deployed HTTP API (e.g., `encoding-service-development-apigw`) and the corresponding Stage.
   - Click Save.

5. **Record 2: Route Cloudflare DNS to API Gateway (Live Traffic):**
   - On the Custom Domain details page in AWS, copy the **API Gateway domain name** (looks like `d-xxxxxxxxxx.execute-api.<region>.amazonaws.com`).
   - Go back to Cloudflare DNS settings.
   - Add a new **CNAME record** for your actual API traffic:
     - **Name:** `api-encode` (or your chosen subdomain)
     - **Target:** The copied API Gateway domain name.
   - **Crucial Setting - Proxied (Orange Cloud ☁️):** Set the Proxy status to **Proxied**. This routes live traffic through Cloudflare first, granting you DDoS protection and WAF capabilities before hitting AWS. 
   - *(Note: Ensure your overall SSL/TLS encryption mode in Cloudflare is set to **Full (Strict)** so the connection between Cloudflare and AWS is encrypted!)*


## Section 3: Deploying to Production

When you are ready to launch to Production, you must bootstrap and pre-provision the environment just like you did for Development, but using production parameters.

### 1. Bootstrap & Pre-provision AWS CDK for Production
If you are running this from AWS CloudShell (where you are already authenticated), you can dynamically fetch your account details to bootstrap the environment:
1. Fetch your Account ID and Region in CloudShell:
   ```bash
   export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   export AWS_REGION=$AWS_REGION
   ```
2. Run the AWS CDK Bootstrap command for the production environment:
   ```bash
   STAGE=production npx aws-cdk@latest bootstrap aws://$AWS_ACCOUNT_ID/$AWS_REGION
   ```

### 2. Pre-provision Fly.io Apps
Create the empty shells for your production compute instances:
```bash
flyctl apps create genai-proxy-server-production
flyctl apps create genai-retrieval-server-production

flyctl ips allocate-v4 -a genai-proxy-server-production
flyctl ips allocate-v6 -a genai-proxy-server-production

flyctl certs add api.genflowly.com -a genai-proxy-server-production
```

### 3. Update Cloudflare DNS & Auth0
1. **Cloudflare**: Add your Fly.io IPv4 and IPv6 addresses as **Proxied** A and AAAA records for `api` (`api.genflowly.com`). Ensure SSL is set to **Full (Strict)**.
2. **Auth0**: Ensure your Auth0 Application allows `https://genflowly.com` and `https://www.genflowly.com` as Allowed Callback, Logout, and Web Origins URLs. The Production API Audience must be `https://api.genflowly.com`.

### 4. Set GitHub Production Environment Secrets
Go to your GitHub Repository > **Settings** > **Environments** > **production** (or global repository secrets) and ensure all secrets are updated for production:
- `AUTH0_SPA_CLIENT_ID` (Production Client ID)
- `AUTH0_API_AUDIENCE` (`https://api.genflowly.com`)
- `AWS_ACCESS_KEY_ID` & `AWS_SECRET_ACCESS_KEY` (Production AWS User)
- `NETLIFY_SITE_ID` (Production Netlify site ID)

### 5. Trigger CI/CD
Open a Pull Request against the `main` branch. When it merges, the `.github/workflows/prod-pipeline.yml` will automatically deploy your frontend to Netlify, sync your AWS CDK infrastructure, and push your backend containers to Fly.io Production!


## Gotchas 
1. Deleting DDB Cloudformation stack doesn't delete the tables created.



## Misc Scripts / Code

### Cloudflare Workers
```js
/**
 * This Cloudflare Worker routes requests to the appropriate destination based on the URL path.
 * Requests to /api are forwarded to an EC2 instance, while all other requests are forwarded to a Netlify app.
 */

const ELB_ENDPOINT = 'api.genflowly.com'; // USE api-development.genflowly.com for development
const NETLIFY_ENDPOINT = 'genflowly-prod.netlify.app'; // update for development

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    let targetUrl;

        // ✅ Handle CORS preflight at the edge
        if (request.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
              "Access-Control-Max-Age": "86400",
            },
          });
        }


    if (url.pathname.startsWith("/api")) {
      // Route /api requests to EC2
      targetUrl = new URL(request.url);
      targetUrl.hostname = ELB_ENDPOINT;



    } else {
      // Route everything else to Netlify
      targetUrl = new URL(request.url);
      targetUrl.hostname = NETLIFY_ENDPOINT;
    }

    console.log({
      incoming: url.pathname,
      outgoing: targetUrl.toString(),
    });

    const response = await fetch(
      new Request(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
      })
    );

    // ✅ Add CORS headers to API responses
    if (url.pathname.startsWith("/api")) {
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    return response;
  },
};


```
