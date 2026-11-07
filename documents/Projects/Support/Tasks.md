# Support page

`/support` on the web app: a form that emails the support inbox. It works signed out, because the App Store listing links to it as the Support URL (`https://genflowly.com/support`).

## How it works

| Piece | Where |
|---|---|
| Page | `genai-react-app/src/pages/SupportPage/` (route `/support`, public) |
| Entry points | Desktop footer, desktop Settings sidebar (above Logout), phone Settings menu (with Privacy policy), Settings search |
| Request | `genai-react-app/src/services/supportService.ts`, POST JSON, never retried |
| API | `gen-ai-proxy-service-SupportStack` in `genai-proxy-server-cdk/lib/support-stack.ts`: HTTP API `POST /support`, no auth, CORS limited to the app's origins, stage throttle 1 request/s with bursts of 5 |
| Handler | `genai-proxy-server-cdk/lambda/support/handler.py`: validates, drops honeypot hits, publishes plain text to SNS |
| Email | SNS topic `gen-ai-proxy-service-<stage>-support-requests`, email subscription to `customer-support@genflowly.com` (`SUPPORT_EMAILS` in the support workflows) |
| Deploy | `.github/workflows/dev-support-api.yml` / `prod-support-api.yml`, from its own CDK app entry `genai-proxy-server-cdk/bin/support.ts` so support changes don't redeploy the proxy; the web deploys read the URL from the stack's `SupportRequestUrl` output |
| iOS | Settings menu row and search hit open the web page in an in-app browser with `?source=ios&appVersion=…` |

Development emails carry `[development]` in the subject. Both stages send to the same inbox.

## One-time steps

- [ ] After the first deploy of each stage, open the "AWS Notification - Subscription Confirmation" email in `customer-support@genflowly.com` and confirm it. Until then nothing is delivered.
- [ ] Optional but recommended: every SNS email has an "unsubscribe" link, and one click on it silently stops support email. Confirm the subscription from the CLI instead of the email link, with the token from that email: `aws sns confirm-subscription --topic-arn <arn> --token <token> --authenticate-on-unsubscribe true` (add `--profile production` for prod). Unsubscribing then needs AWS credentials.
- [ ] Add support requests to the privacy policy: what the form collects (name, email, message, account ID when signed in, browser), that it goes to the support inbox, and how long it's kept. Not done: `Policy.md` and `public/privacy-policy.md` are the user's to change.
- [ ] App Store Connect: Support URL `https://genflowly.com/support`.

## Decisions

- SNS email can't set Reply-To. The email's first header line is "Reply to: Name <address>" to copy from.
- The account ID is what the app sends, not verified: the API has no auth so the form works signed out.
- No CAPTCHA. A hidden field catches simple bots and the throttle bounds the rest. If spam arrives, add Cloudflare Turnstile.
- iOS uses the web page instead of a native form, so the app needs no API URL and there is one form to maintain.

## Verified (2026-11-07)

- Lambda: 18 unit tests. CDK synth for both stages: one route, no authorizer, CORS origins per stage, throttle on `$default`, topic denies non-TLS publish, Lambda asset is `handler.py` only.
- Web: page, service, sidebar and footer tests; coverage gate passed; CI build passed.
- End to end locally: the real handler behind a local stand-in for API Gateway, the dev server at phone width: invalid email flagged on blur, send, confirmation, the email text, a failed send offering the address, desktop layout, desktop sidebar, phone Settings menu, dark mode.
- Not exercised: the deployed API, real SNS delivery, the iOS row in the simulator (Settings needs a signed-in session).
