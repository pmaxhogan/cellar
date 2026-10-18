# Security Policy

## Supported versions

Cellar is pre-1.0 and has no tagged releases yet. Only the current `main` branch and
the `ghcr.io/pmaxhogan/cellar:latest` image built from it are supported. Fixes land
on `main` and ship in the next `latest` image; there are no backports to older
`sha-*` tags.

## Reporting a vulnerability

Report privately through GitHub, not in a public issue: go to the
[Security tab](https://github.com/pmaxhogan/cellar/security) of `pmaxhogan/cellar`
and choose **Report a vulnerability**. That opens a private advisory visible only to
you and the maintainer.

Useful details: affected version or image tag, whether the Cloudflare Access setup
from [`docs/setup-cloudflare.md`](docs/setup-cloudflare.md) is in place, reproduction
steps, and impact. Please never include real cookies, tokens or keys in a report.

Cellar is maintained by one person in their spare time. There is no bug bounty and no
paid support. Response is best effort: expect an acknowledgement within about a week,
and a fix timeline that depends on severity. Please allow a reasonable window for a
fix before disclosing publicly.

## Threat model

Cellar is a self-hosted, **single-tenant** archiver: one owner, one deployment, on a
home NAS, reachable only through a Cloudflare Tunnel. The authoritative description of
the design is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); this is a summary of the
properties cellar tries to hold, and of the ones it does not.

### Assets

In rough order of value:

- **Cookie jars.** A YouTube `cookies.txt` is a logged-in session for the owner's
  Google account. It is the most valuable thing cellar holds.
- **OAuth refresh tokens.** One per linked account, `youtube.readonly` scope. They
  read subscriptions, likes and metadata; they cannot write to the account.
- **The Google OAuth client secret** (`GOOGLE_CLIENT_SECRET`) in `.env`.
- **Proxy URLs.** They usually embed credentials for a paid proxy.
- **`CELLAR_SECRET_KEY`.** The key that encrypts the three items above at rest.
- **The catalog.** The database of what the owner subscribes to, likes and has
  watched (watch history is sensitive), plus the downloaded media itself.
- **Share tokens**, which are bearer capabilities for the specific videos they name.

### Trust boundaries

1. **The internet to Cloudflare Access.** Every path except `/healthz` and `/s` is
   behind a Cloudflare Access application that allows only the owner's email.
2. **Cloudflare to cellar.** Cellar does not trust that boundary blindly: it verifies
   the Access JWT itself on every non-public request (signature against the team's
   keys, issuer, audience, expiry, and the `email` claim against
   `CF_ACCESS_ALLOWED_EMAILS`) and answers 401 on any failure. It refuses to start
   unless those settings are present. A misconfigured or too-wide Access rule is
   therefore not by itself a breach.
3. **The public share surface.** `/s` is deliberately reachable by anyone who holds a
   link, with Access set to Bypass for it. The app's public prefix list is exactly
   `["/healthz", "/s"]`, matched at `/` boundaries and case-sensitively.
4. **The container to everything else.** See "Container hardening".

### The public share surface

Share links exist so the owner can send a friend one video. By design:

- The token is **16 random bytes, base64url, 22 characters**, from the CSPRNG. It is
  stored **in plaintext** in the database. This is a deliberate choice by the owner:
  "no client-side security theatre". The token is a bearer secret either way; hashing
  it would protect only against database disclosure, and the database already holds
  the catalog that a share would reveal. The link is revocable and can expire.
- **Every invalid state returns the identical 404** page and headers: an unknown,
  malformed, expired or revoked token, a live link's missing file or bad caption
  language, any unknown sub-path, and the same under `HEAD` and under any other method
  (a `POST` included). No response can be used to tell those cases apart or to probe
  which tokens ever existed; only a valid token answers anything else. Only the rate
  limit's 429 differs.
- Token URLs are bearer secrets, so the token routes log at `warn` and above only: a live
  link never lands in the request log. Media is served `no-cache` so a revoked link stops
  at once, and the downloadable metadata is built from an **allowlist** of info.json
  keys, so container paths, request headers, signed format URLs and the names of the
  owner's playlists never leave.
- Public endpoints are **rate limited per IP** (in memory, token bucket).
- Pages send `X-Robots-Tag: noindex, nofollow` and a `noindex` robots meta tag.
- The surface is **not enumerable**: there is no index, listing or search under `/s`;
  the only public routes are `/s/<token>`, `/s/<token>/...` for that share's own media,
  captions and metadata, and the public bundle's static assets under `/s/assets/`.
- **No settings, rules, accounts or admin API are reachable** from
  the public bundle. It has no API access beyond `/s/<token>/*`.
- **Downloads are always allowed** on a share page; there is no per-link download
  toggle. A share is a copy you have chosen to hand over. Revoke it if that changes.

A bypass entry also opens everything beneath its path, which is why the admin bundle
never lives under `/s`, nothing may be registered there without its own
authentication, and the app's own public list is the second lock behind Access's. See
[`docs/setup-cloudflare.md`](docs/setup-cloudflare.md).

Access matches paths case-insensitively while the app router is case-sensitive.
`/S/nope` passes the bypass but is not a public path to the app, which answers 401
without serving anything (`/s/nope` answers 404 from the app). Both layers fail
closed.

### The Takeout upload surface

`POST /api/takeout` is the only endpoint that accepts a file upload, and the only place
cellar unpacks an archive. Properties:

- **Owner only.** It sits behind Access and the app's own JWT check like the rest of
  `/api`; it is not under `/s`. Multipart parsing is registered for that one route only.
- **Size capped.** One request may carry up to 500 files and 2 GB in total; larger ones
  are refused with 413. Files stream to disk under `/data/tmp` (directory 0700, files
  0600), never into memory, and the staging directory is deleted when the import
  finishes or is rejected.
- **Traversal refused.** An archive with an absolute or `..` member is rejected whole
  before anything is extracted; zip entries are written under generated names, a tarball
  is extracted by the system `tar` into its own subdirectory, only regular files whose
  real path stays inside it are read, and symlinks are skipped.
- **No decompression-bomb guard.** The 2 GB cap applies to the compressed upload; the
  unpacked size is not limited, so an archive that expands enormously could fill `/data`.
  The uploader is the authenticated owner, so this is accepted rather than defended.
- Only `watch-history.json`, playlist CSVs and `subscriptions.csv` are parsed (as data,
  never executed); everything else in an archive is skipped.

### Private details guard

The repository is public, but the maintainer's deployment is not. `scripts/check-private.mjs`
fails CI (and `npm run lint:private`) when any tracked text file matches a private
pattern, such as the real hostname, dataset paths, usernames or ids. The patterns are
**never in the tree**: they are held in a repository secret (`PRIVATE_PATTERNS`) and, for
local runs, in a file in the maintainer's home directory. A failure prints only
`file:line`, never the match, and a push to the default branch fails closed when the
secret is not configured. Docs and examples use hypothetical values instead (host `nas`,
`/mnt/tank/apps/cellar`, `<team>.cloudflareaccess.com`, `owner@example.com`).

### Secrets at rest

- Refresh tokens, cookie jars and proxy URLs are encrypted with **AES-256-GCM** under
  `CELLAR_SECRET_KEY`, a 64 hex character key supplied through the environment and
  never written to the database. Secrets are write-only over the API: responses say a
  secret exists, never what it is.
- **Decrypted cookies only ever touch one place**: a file with mode 0600 under
  `/data/tmp`, created for a single yt-dlp invocation and deleted in a `finally`
  block. After each run the refreshed jar (YouTube rotates cookies) is re-encrypted
  and **written back**; the stale one is not kept.
- `.env` is mode 0640 and owned by the container's uid; the key and the Google client
  secret live there and nowhere in the repository (the repo is public, `.env` is
  gitignored, and `.env.example` holds placeholders only).
- Losing `CELLAR_SECRET_KEY` makes every stored secret unrecoverable; leaking it
  together with a copy of `/data` exposes them all. Keep the key and the data backup
  apart.

### Process hygiene

- yt-dlp and ffmpeg are started with an **argv array, never a shell**, so nothing a
  video title, URL or setting contains is parsed as a command.
- **Extra yt-dlp arguments are allowlisted.** A rule or setting cannot add arbitrary
  flags (such as `--exec` or an output template that writes outside the video's
  directory).
- **Regex conditions in rules are guarded** against catastrophic backtracking (length
  limits and a safe-regex check or a timeout), so an owner-authored pattern cannot
  wedge the server.
- **No credentials in argv, and argv is redacted before it is logged.** Cookies are
  passed as a file path (never inline) and proxy URLs come from the encrypted store. The
  download pipeline logs its yt-dlp argv only through a redactor: the `--proxy` value
  keeps its host but loses its credentials, anything else URL-shaped is masked
  (`scheme://***@host`), and the same masking is applied line by line to the per-job
  `yt-dlp.log`. The cookie file path may appear in a log; its contents never do.
- **pino redaction** covers `cookie`, `authorization`, `cf-access-jwt-assertion`,
  `refresh_token`, `client_secret` and proxy URLs, in both the stdout stream and the
  rotating log file.
- **Credentials never appear in logs, URLs, API responses or error messages.** 5xx
  responses carry a fixed message; the real error goes to the log only.
- Per-job log files keep the job log and yt-dlp and ffmpeg output (with the redacted
  argv) for 14 days (60 for failures). They are on the 750 `data` dataset. Treat them as
  sensitive when sharing logs for support: they name video ids and titles.

### Container hardening

The Custom App ([`deploy/docker-compose.nas.yml`](deploy/docker-compose.nas.yml)):

- Runs as **`3100:3100`**, a uid/gid that does not exist on the NAS OS. Its datasets
  (`tank/apps/cellar/{data,media}`) are owned by it with mode **750**, so the `apps`
  user (568) and other local users cannot read cellar's files, and cellar cannot read
  theirs.
- `cap_drop: [ALL]` with nothing added back, and `no-new-privileges:true`.
- **`read_only: true` root filesystem** with a size-limited (512 MB), `noexec` `tmpfs` on
  `/tmp` and one dedicated executable `tmpfs` at `/run/ytdlp` (1 GB, mode 0700, owned by
  the container uid, set as `TMPDIR`), because the single-file yt-dlp build unpacks
  itself into its temp dir on every run. Nothing else is mounted executable. This was
  verified to work together with the nvidia runtime and `cap_drop ALL`. The only
  writable places are `/tmp`, `/run/ytdlp`, `/data` and the `/media` mounts.
- **No published ports.** The Cloudflare tunnel reaches the service over the internal
  app network by its DNS alias; nothing listens on the NAS's LAN address for cellar.
- The **bgutil PO-token sidecar is internal only** (no ports, reachable by name from
  the cellar container). It also runs `cap_drop ALL` and `no-new-privileges`, as the
  same non-root uid, with a read-only root filesystem and its own small `tmpfs`.
- GPU access is a device reservation, not `privileged`.
- Logs are `json-file`, 20 MB by 3 files.

### The yt-dlp supply chain

Cellar downloads and executes tools from the internet on a schedule, so it is built
to verify them:

- **yt-dlp** comes from the official GitHub release as the single-file `yt-dlp_linux`
  binary, and its **sha256 is verified against the release's `SHA2-256SUMS`** before
  use.
- **ffmpeg and ffprobe** come from BtbN's static builds, from the release named by the
  `tools.ffmpeg_release_tag` setting. The default is a **pinned** dated release (the one
  the image ships); `latest` is an explicit opt-in. The archive's **sha256 is verified
  against the release's `checksums.sha256`** before use.
- Updates are **atomic**: a new version is staged, verified (checksum, then a version
  probe run from the staging directory), and swapped in with a rename, and **the
  previous version is kept as `<tool>.prev` for rollback**. The image ships a baseline
  copy, so a failed update never leaves cellar without a working tool. The Self-check
  page reports installed versions and update problems.
- A staged ffmpeg that can no longer open an NVENC encoder the live one can is
  **refused** (the update outcome is `blocked`), so an update cannot silently break
  hardware encoding.
- The tools live in `/data/bin`, owned by `3100`, writable only by cellar.

Not verified beyond that: the BtbN checksum file comes from the same GitHub release as
the archive, so the build's integrity rests on GitHub and TLS; the bgutil plugin zip has
no published checksum at all. The sidecar images `bgutil` and `watchtower` use floating
`latest` tags with watchtower auto-updating them, as do cellar's own images.

## What is NOT protected

Be clear-eyed about these; none of them is fixable by cellar:

- **A compromised owner browser session.** Anyone with the owner's authenticated
  browser can use the whole admin UI: read cookie-backed data, create shares, change
  rules and proxies. Cellar cannot distinguish them from the owner. Secrets are
  write-only through the API, but a session can still make cellar use them.
- **Cloudflare itself.** Cloudflare terminates TLS and issues the Access tokens. A
  compromise of the Cloudflare account, of the Zero Trust team, or of Cloudflare
  infrastructure is a compromise of cellar's front door, and the share traffic is
  visible to Cloudflare.
- **The owner's Google account and YouTube terms of service.** Cellar uses the
  owner's cookies and automates downloads, which YouTube's terms do not permit.
  Account warnings, throttling, CAPTCHA or "confirm you are not a bot" walls, or a
  termination are possible. That is a risk the owner accepts by running cellar; the
  per-account request gap and budget, and the option to point accounts at proxies,
  reduce but do not remove it.
- **Share links, once sent.** Anyone who has a link can open it, forward it and
  download the media until it is revoked or expires. The token is not tied to an
  identity.
- **Pushes to `main`, GHCR, and watchtower.** Anything that lands on `main` becomes
  the running image within about two minutes, with access to the cookie jars. Protect
  the GitHub account (2FA, branch protection once enabled) accordingly. Watchtower
  mounts the Docker socket, which is root-equivalent on the NAS; the same pattern is
  used for the other apps there.
- **The NAS itself.** Anyone with root on the NAS (or `sudo` from the admin user) can
  read everything, including `.env` and the decrypted data in memory. Disk theft is
  mitigated only by whatever ZFS-level encryption the pool has; cellar adds the
  application-level encryption described above, not full-disk encryption.
- **Metadata and media content.** Titles, descriptions and captions are untrusted
  text from the internet, escaped by the UI. A downloaded media file is untrusted
  input to ffmpeg and to the owner's players; keep ffmpeg updated (which the updater
  does).

## Hardening recommendations for self-hosters

- **Put the Access application in front first, then the tunnel.** Never set
  `INSECURE_ALLOW_PUBLIC_ACCESS` on anything reachable from a network.
- **Keep the bypass narrow.** Exactly `s` (and `healthz`); nothing broader.
- **Dedicated uid and datasets.** Do not run cellar as `apps` or root, and do not
  share its datasets with other services.
- **Protect `CELLAR_SECRET_KEY` and `.env`.** Keep a copy of the key in a password
  manager, separate from data backups.
- **Use a throwaway or secondary Google account for cookies if you can.** The cookies
  authorise the whole account.
- **Revoke shares you no longer need,** and set an expiry on one-off shares.
- **Keep the image updated.** The compose file includes a label-scoped watchtower
  sidecar for this.

## Out of scope

The following will be closed without a fix:

- Anything that requires `INSECURE_ALLOW_PUBLIC_ACCESS=1`. That flag documents itself
  as removing authentication, binds loopback only, and warns continuously.
- Share-link enumeration or guessing at the documented entropy (128 bits) and rate
  limit, and the plaintext storage of share tokens, which is a documented decision.
- Vulnerabilities in upstream yt-dlp, ffmpeg, Node, bgutil, watchtower or system
  packages in the image. Report those to their maintainers. If cellar uses one in a
  way that makes an upstream issue materially worse, that part is in scope.
- Abuse of the owner's own authenticated session or of an already-sent share link.
- YouTube terms-of-service or account-enforcement consequences of using the tool.
- Resource exhaustion from a very large subscription or history import, including a
  Takeout archive that expands far beyond its compressed size (there is no
  decompression-bomb guard; see "The Takeout upload surface").
- Findings from automated scanners with no demonstrated exploit path.
