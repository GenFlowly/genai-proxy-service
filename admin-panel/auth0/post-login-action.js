/**
 * Auth0 post-login Action: restrict admin-panel logins to verified accounts
 * on the allowed email domain.
 *
 * Install: Auth0 Dashboard → Actions → Library → Create Action
 *   name: "Restrict admin panel to genflowly.com"
 *   trigger: Login / Post Login
 * Paste this file, add the Secrets below (🔑 panel), Deploy, then drag the
 * action into the Login flow (Actions → Flows → Login).
 *
 * Secrets:
 *   ADMIN_CLIENT_IDS   comma-separated admin-panel Auth0 clientIds (dev,prod)
 *   ADMIN_EMAIL_DOMAIN allowed domain, no leading @ (e.g. genflowly.com)
 *
 * Only the applications listed in ADMIN_CLIENT_IDS are affected — react-app
 * logins never enter the check, and SSO is preserved: an allowed user who
 * signed in via the react app passes silently; anyone else is denied only
 * when they open the admin panel. If ADMIN_CLIENT_IDS is unset the action
 * no-ops for every application (fails open), so verify the secret saved.
 *
 * The email_verified requirement is what makes the domain check trustworthy:
 * database-connection signups can claim any address unverified, so without it
 * a fake @genflowly.com registration would pass. The backend re-enforces the
 * same domain (ADMIN_EMAIL_DOMAIN) plus the ADMIN_EMAILS allowlist.
 */
exports.onExecutePostLogin = async (event, api) => {
  const adminClientIds = (event.secrets.ADMIN_CLIENT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const adminDomain = (event.secrets.ADMIN_EMAIL_DOMAIN || 'genflowly.com')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();

  // Admin-panel applications only — all other apps (react-app) are untouched
  if (!adminClientIds.includes(event.client.client_id)) return;

  const email = (event.user.email || '').toLowerCase();
  if (!email.endsWith(`@${adminDomain}`) || !event.user.email_verified) {
    api.access.deny(`Admin panel access is restricted to verified ${adminDomain} accounts.`);
  }
};
