# Cloudflare setup (Access + tunnel)

Cellar sits behind a Cloudflare Tunnel and two Cloudflare Access applications on
the same hostname, `cellar.maxhogan.dev`:

1. a **host app** over the whole hostname with an Allow policy for the owner's
   email, and
2. a **share app** over the path `s` (plus the exact path `healthz` for the health
   check), with a Bypass policy for Everyone, so share links open for people without
   a Cloudflare identity.

The tunnel then forwards the hostname to the container. Do the Access apps first and
the tunnel route last, so the hostname is never reachable before it is gated. (The
app also verifies the Access JWT itself and answers 401 without one, so a gap is not
an open door, but there is no reason to leave one.)

Dashboard labels move around between Zero Trust releases; the names below are the
ones in use when this was written. If a field is named differently, match it by
meaning.

## 1. The host Access app (Allow owner)

In the Cloudflare dashboard open Zero Trust, then Access -> Applications.

1. Add an application -> **Self-hosted**.
2. Application name: `cellar`. Session duration: whatever you like (24 hours is
   fine).
3. Public hostname: subdomain `cellar`, domain `maxhogan.dev`, **path left empty**
   (the whole host).
4. Policy: name `owner`, action **Allow**, include rule **Emails**, value your email.
   Add nothing else.
5. Save the application, then open it and copy the **Application Audience (AUD)
   Tag** from its overview.
6. On the NAS, put it in the env file and redeploy:

   ```bash
   sudo nano /mnt/tank/apps/cellar/.env      # CF_ACCESS_AUD=<the AUD tag>
   sudo midclt call -j app.redeploy cellar
   ```

   `CF_ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`, shown under Settings ->
   Custom pages) is already set. The same team is used by amber.

Cellar verifies the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization`
cookie): signature against the team's keys, issuer, audience, expiry and the
`email` claim against `CF_ACCESS_ALLOWED_EMAILS`. Until `CF_ACCESS_AUD` is set the
container refuses to start; that is expected.

## 2. The share Access app (Bypass `s`)

Share links (`/s/<token>`) have to open for friends who have no Access identity.
They are protected by the unguessable token and the app's own public surface
(see [SECURITY.md](../SECURITY.md)), so Access is told to step aside for that one
path.

1. Access -> Applications -> Add an application -> **Self-hosted**.
2. Application name: `cellar share`.
3. Public hostname: subdomain `cellar`, domain `maxhogan.dev`, **path `s`**
   (no slash, no wildcard). Access treats this as `/s` and everything beneath it.
4. Policy: name `public share`, action **Bypass**, include rule **Everyone**.
5. Add a second destination to the same application for the health check: subdomain
   `cellar`, domain `maxhogan.dev`, path `healthz`.
6. Save. Do **not** copy this app's AUD anywhere; `CF_ACCESS_AUD` is the host
   app's tag.

Cloudflare applies the most specific path match, so `/s/...` is governed by this app
and every other path by the host app. If your dashboard instead lets you scope
policies by path inside a single application, an equivalent single-app layout
(Bypass on path `s`, Allow on the rest) works too; the two-app layout is the one
this runbook and the verification below were written for.

### Propagation caveat

Right after the entry is created, behaviour for sub-paths can lag for some
minutes: `/s/...` may still be redirected to the Access login at first and stop being
so later. Wait five to ten minutes before trusting a check made immediately after
adding or editing the app, and re-run the checks below once more later.

### What the bypass opens, and why the prefix list is exactly two entries

A bypass entry for `s` also opens **everything beneath the path**. Whatever is
reachable at `/s/<anything>` is reachable by the whole internet without an Access
identity. That is the reason for three rules, all enforced in the app rather than
trusted to Access:

- The app's public prefix list is exactly `["/healthz", "/s"]`. Matching happens at
  `/` boundaries and is case-sensitive, so `/s` and `/s/x` are public, while `/sx`,
  `/S/x` and `/api/...` are not. Everything else needs a valid Access JWT whether or
  not Cloudflare gated it first.
- The only routes under `/s` are `/s/<token>`, `/s/<token>/...` (the media, captions
  and metadata for that one share), the public bundle's own assets under `/s/assets/`,
  and two static legal pages, `/s/privacy` and `/s/tos`, which the Google OAuth consent
  screen links to (they answer 200 without a token and carry no data). Every other path
  under `/s`, any other method and every invalid token answer the same 404 page.
- **The admin bundle never lives under `/s`.** The admin SPA, its assets and all of
  `/api/*` are served from other paths, so the bypass never exposes them. Nothing may
  ever be registered under `/s` without its own authentication.

`/healthz` is the other public path. For it to answer 200 from outside (check 1
below), add it as a second destination of the same bypass app: public hostname
`cellar.maxhogan.dev`, path `healthz`. It carries no data and nothing is mounted
beneath it. Without that destination the app still treats `/healthz` as public (so
container health checks on loopback work), but an external request is redirected to
the Access login by the host app.

## 3. The tunnel public hostname

Zero Trust -> Networks -> Tunnels -> the existing tunnel (the one cloudflared on the
NAS runs, token-managed) -> **Public Hostnames** -> Add a public hostname.

- Subdomain `cellar`, domain `maxhogan.dev`, path empty.
- Service type **HTTP**, URL `cellar.ix-cellar.svc.cluster.local:8080`, that is the
  origin `http://cellar.ix-cellar.svc.cluster.local:8080`.

TrueNAS Custom Apps join a shared internal network with the DNS alias
`<compose-service>.ix-<appname>.svc.cluster.local`, and the cloudflared connector is
on that network. A bare `http://cellar:8080` does **not** resolve from cloudflared;
using it gives a 502.

## 4. Verify with curl

Run these from any machine outside your network, after the propagation wait. They are
the acceptance test for the whole Cloudflare side.

```bash
curl -sI https://cellar.maxhogan.dev/healthz | head -1
curl -sI https://cellar.maxhogan.dev/ | head -3
curl -sI https://cellar.maxhogan.dev/s/nope | head -3
curl -sI https://cellar.maxhogan.dev/S/nope | head -3
```

| Request      | Expected                                                                                          | What it proves                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `/healthz`   | `HTTP/2 200`                                                                                      | The tunnel reaches the container and the app's public list includes `/healthz`. |
| `/`          | `HTTP/2 302`, `location: https://<team>.cloudflareaccess.com/cdn-cgi/access/login/...`            | The host app gates the admin UI.                                                |
| `/s/nope`    | `HTTP/2 404` (the app's uniform not-found page, with `x-robots-tag: noindex, nofollow`), not 302  | The bypass reaches the app, which treats an unknown token as plain not-found.   |
| `/S/nope`    | `HTTP/2 401` JSON from the app (observed; a 302 to the login is also acceptable)                   | A differently-cased path is not public (explained below).                       |

If `/s/nope` redirects to the login, the share app is missing, has the wrong path, or
is still propagating. If `/healthz` redirects, the `healthz` destination is missing
from the share app (or still propagating).

### Why `/S/nope` is a 401 and `/s/nope` is a 404

The two layers do not agree about letter case. The app's router and its public
prefix list are **case-sensitive**: `/s` is public, `/S` is not. Cloudflare Access
path matching was observed on another app behind the same kind of entry (healthy,
in production) to be **case-insensitive**, so a capitalised path can pass Access
where the app would not treat it as public. For cellar that mismatch is harmless
in both directions, because every outcome is closed:

- Access matches the `s` bypass case-insensitively, so `/S/...` reaches the app
  without a JWT. The app does not consider `/S` public, demands a valid Access JWT,
  and answers 401 with no share content. This is what was observed on amber's
  equivalent entry (`/GIT/x` -> 401 while `/git/x` -> 404) and is the expected
  result for cellar.
- If Access ever sends the request to the login instead (302), nothing from the
  app is served either.

Both outcomes are closed; the contrast with `/s/nope` (404 from the app itself)
shows that only the lowercase prefix is served as public content.
This is Cloudflare's behaviour, not something this repository controls, so re-run the
check after any change on Cloudflare's side. Sibling paths such as `/sx` are not
matched by the `s` entry and stay behind the login as well (observed on healthy for
the equivalent exact-path entry; not separately re-checked here).

## 5. Request size limit (Takeout uploads)

Cloudflare caps one proxied request body at 100 MB on the Free and Pro plans (higher on
Business and Enterprise), and the tunnel hostname is proxied. Cellar's own limit for a
Google Takeout upload (`POST /api/takeout`) is 2 GB, so a large archive sent through
`cellar.maxhogan.dev` is cut off at Cloudflare's edge before the app sees it, and the
browser shows a network or Cloudflare error rather than a cellar message. This is
Cloudflare's behaviour, not a setting here. Upload the loose files from inside the archive
instead (`watch-history.json`, the playlist CSVs and `subscriptions.csv`; they are usually
far smaller than the archive), one request each if needed. Nothing else in cellar uploads
large bodies: the share media routes and bulk ZIP downloads are downloads, which the
request cap does not limit.

## Troubleshooting

- `/` gives a JSON 401 from cellar instead of an Access redirect or the app: the
  request reached the origin without a valid token. Check `CF_ACCESS_AUD` is the
  **host** app's tag, `CF_ACCESS_TEAM_DOMAIN` has no scheme or trailing slash, your
  email is in `CF_ACCESS_ALLOWED_EMAILS`, and the NAS clock is correct (the verifier
  allows 30 s of skew).
- A redirect loop: the share app must have the path `s`; a path-less bypass app
  overlaps the whole host.
- 502 or 1033 from Cloudflare: the tunnel is down or the origin is wrong; see step 3
  and `sudo docker logs` for the cloudflared container.
- Changed a policy and nothing changed: wait a few minutes and retry in a private
  window, because Access caches the `CF_Authorization` cookie for the session.
