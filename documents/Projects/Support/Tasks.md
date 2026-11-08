# Support page

`/support` on the web app: a form that emails the support inbox. Anyone can open the page, because the App Store listing links to it as the Support URL (`https://genflowly.com/support`), but only a signed-in user can send. Signed out, it shows a Sign in button and the support address for people who can't sign in.

## How it works

| Piece | Where |
|---|---|
| Page | `genai-react-app/src/pages/SupportPage/` (route `/support`, public) |
| Entry points | Desktop footer, desktop Settings sidebar (above Logout), phone Settings menu (with Privacy policy), Settings search |
| Request | `genai-react-app/src/services/supportService.ts`, POST JSON with the user's Auth0 access token, never retried |
| API | `gen-ai-proxy-service-SupportStack` in `genai-proxy-server-cdk/lib/support-stack.ts`: HTTP API `POST /support` behind an Auth0 JWT authorizer (issuer `AUTH0_SPA_DOMAIN`, audience `AUTH0_API_AUDIENCE`, the tokens the web and iOS apps get), CORS limited to the app's origins, stage throttle 1 request/s with bursts of 5 |
| Handler | `genai-proxy-server-cdk/lambda/support/handler.py`: refuses requests without a verified user, validates, drops honeypot hits, publishes plain text with the verified Auth0 user ID to SNS |
| Email | SNS topic `gen-ai-proxy-service-<stage>-support-requests`, email subscription to `customer-support@genflowly.com` (`SUPPORT_EMAILS` in the support workflows) |
| Deploy | `.github/workflows/dev-support-api.yml` / `prod-support-api.yml`, from its own CDK app entry `genai-proxy-server-cdk/bin/support.ts` so support changes don't redeploy the proxy; the web deploys read the URL from the stack's `SupportRequestUrl` output |
| iOS | Native form, `AI Wrapper/Views/Support/SupportView.swift` (route `.support`), from the Settings menu row and search hit. `Services/SupportService.swift` posts to the same API with the app's own access token, never retried. The URL is `SUPPORT_API_URL` per stage in `BuildSettings/Environments/`, the stack's `SupportRequestUrl` output; if the API is ever recreated, update those files |

Development emails carry `[development]` in the subject. Both stages send to the same inbox.

## One-time steps

- [ ] After the first deploy of each stage, open the "AWS Notification - Subscription Confirmation" email in `customer-support@genflowly.com` and confirm it. Until then nothing is delivered.
- [ ] Optional but recommended: every SNS email has an "unsubscribe" link, and one click on it silently stops support email. Confirm the subscription from the CLI instead of the email link, with the token from that email: `aws sns confirm-subscription --topic-arn <arn> --token <token> --authenticate-on-unsubscribe true` (add `--profile production` for prod). Unsubscribing then needs AWS credentials.
- [ ] Add support requests to the privacy policy: what the form collects (name, email, message, account ID when signed in, browser), that it goes to the support inbox, and how long it's kept. Not done: `Policy.md` and `public/privacy-policy.md` are the user's to change.
- [ ] App Store Connect: Support URL `https://genflowly.com/support`.

## Decisions

- SNS email can't set Reply-To. The email's first header line is "Reply to: Name <address>" to copy from.
- Sending needs sign-in (user's call, 2026-11-07, to stop anonymous spam). The email's "Signed in as" line is the Auth0 user ID API Gateway verified; the account ID next to it is still what the app sends.
- The throttle is per stage, not per user: one signed-in account could still send a request a second. If that happens, add a per-user limit (a DynamoDB counter in the Lambda).
- Signed-out visitors see the support address, for people locked out of their account and for App Review.
- iOS has a native form (user's call, 2026-11-08). The app signs in separately from its in-app browser, so the web page would have asked people to sign in again. The web page still accepts `?source=ios&appVersion=…` for builds that open it.

## Verified (2026-11-07)

- Lambda: 18 unit tests. CDK synth for both stages: one route, no authorizer, CORS origins per stage, throttle on `$default`, topic denies non-TLS publish, Lambda asset is `handler.py` only.
- Web: page, service, sidebar and footer tests; coverage gate passed; CI build passed.
- End to end locally: the real handler behind a local stand-in for API Gateway, the dev server at phone width: invalid email flagged on blur, send, confirmation, the email text, a failed send offering the address, desktop layout, desktop sidebar, phone Settings menu, dark mode.
- Not exercised: the deployed API, real SNS delivery, the iOS row in the simulator (Settings needs a signed-in session).

## Verified (2026-11-08, iOS native form)

- 230 iOS unit tests, including the form's rules and the request's JSON.
- Simulator, against the real `handler.py` behind a local stand-in for API Gateway that rejects requests without a token, with SNS stubbed: open from Settings, prefill, topic menu, send, the email text, Send another, a 502 (one attempt, error shown, nothing retried), sending again, invalid email, a long message staying above the keyboard, privacy link, swipe back, dark mode.
- Not exercised: the deployed API, real SNS delivery, a real device.
