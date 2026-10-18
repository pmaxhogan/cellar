/**
 * Static legal pages served without authentication under /s/privacy and /s/tos.
 * They exist because the Google OAuth consent screen (Production status) asks for a
 * privacy policy and terms-of-service URL. Cellar is single-tenant software run by
 * its owner for their own data, so the text says exactly that. No tracking, no third
 * parties, no accounts other than the owner's.
 */

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Cellar</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; background: #151013; color: #f5eef1; }
  main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  h1 { font-size: 1.75rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 0.5rem; }
  p, li { color: #e4d8dd; }
  .muted { color: #bba9b1; font-size: 0.9rem; }
  a { color: #e2738e; }
  @media (prefers-color-scheme: light) {
    body { background: #faf7f8; color: #1f181c; }
    p, li { color: #352b31; }
    .muted { color: #6b5a62; }
    a { color: #8e2643; }
  }
</style>
</head>
<body>
<main>
${body}
<p class="muted">Cellar is open-source software (MIT), <a href="https://github.com/pmaxhogan/cellar">github.com/pmaxhogan/cellar</a>. This instance is operated privately by its owner.</p>
</main>
</body>
</html>
`;
}

export const PRIVACY_HTML = page(
  "Privacy policy",
  `<h1>Privacy policy</h1>
<p class="muted">Last updated 2026-10-18</p>
<p>Cellar is a self-hosted, single-tenant YouTube archiver. This instance is run by one
person, for that person's own YouTube accounts. There are no other users, no customer
accounts, and nothing is sold, shared or used for advertising.</p>
<h2>What the application accesses</h2>
<ul>
  <li>Through the Google OAuth consent you grant, Cellar uses the YouTube Data API with the
  read-only scope (<code>youtube.readonly</code>) to read the connected account's
  subscriptions, liked videos and public video metadata.</li>
  <li>Cookies you export from your own browser session may be stored to read watch history
  and Watch Later, which the API does not expose.</li>
</ul>
<h2>How data is stored</h2>
<ul>
  <li>Everything is stored on hardware the owner controls. OAuth refresh tokens and cookies
  are encrypted at rest (AES-256-GCM) and are never written to logs or sent anywhere other
  than Google and YouTube.</li>
  <li>Google user data is used only to build and maintain the owner's personal video
  archive. It is not transferred to, or used by, any third party, and it is not used for
  advertising or to build profiles.</li>
  <li>Revoking the application's access in your Google Account settings, or deleting the
  linked account inside Cellar, deletes the stored token.</li>
</ul>
<h2>Public share links</h2>
<p>A share link shows one video and its metadata to anyone who has the link. Share pages
set no cookies, run no analytics, and are marked noindex. Request counts per link are kept
by the owner to notice abuse.</p>
<h2>Google API Services User Data Policy</h2>
<p>Cellar's use of information received from Google APIs adheres to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API
Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>Contact</h2>
<p>Questions go to the repository's issue tracker linked below.</p>`,
);

export const TOS_HTML = page(
  "Terms of service",
  `<h1>Terms of service</h1>
<p class="muted">Last updated 2026-10-18</p>
<p>Cellar is personal, self-hosted software. This instance is operated by its owner for
the owner's own use. It is not a service offered to the public, and no account can be
created on it.</p>
<h2>Share links</h2>
<p>If the owner gives you a share link you may view and download the content it points to
for personal use. Links can expire or be revoked at any time without notice. Do not
attempt to enumerate, scrape or rate-abuse share links.</p>
<h2>Content</h2>
<p>Archived videos remain subject to the rights of their original creators and to
YouTube's Terms of Service. The owner is responsible for how the archive is used.</p>
<h2>No warranty</h2>
<p>The software is provided under the MIT licence, as is, without warranty of any kind.</p>`,
);
