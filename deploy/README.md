# cellar - TrueNAS deploy runbook

Operator runbook for the NAS (`nas`, TrueNAS SCALE 25.10) deployment of
cellar as a Custom App behind the existing Cloudflare tunnel at
`https://cellar.maxhogan.dev`. The compose file is
[`docker-compose.nas.yml`](docker-compose.nas.yml); the Cloudflare side is in
[`../docs/setup-cloudflare.md`](../docs/setup-cloudflare.md); the threat model is in
[`../SECURITY.md`](../SECURITY.md).

Everything marked "done" below has already been done on the NAS. The commands are
kept so the setup can be rebuilt from nothing or audited later.

## Auto-deploy chain

Push to `main` -> `build-image.yml` builds, smoke-tests and pushes
`ghcr.io/pmaxhogan/cellar:latest` -> the `cellar-watchtower` sidecar (polling every
120 s, label-scoped, rolling restart, cleanup on) sees the new digest and
recreates `cellar` and `cellar-bgutil`. A change reaches the NAS about two
minutes after a green push, with no SSH. Watchtower reads GHCR credentials from the
mounted `/root/.docker/config.json` (the same login the amber and mkvid watchtowers
use); nothing more to set up.

Watchtower only swaps images. It clones the running container's environment and does
not re-read `env_file`, so `.env` edits and compose edits need an explicit
`app.redeploy` / `app.update` (see "Updating").

## Prerequisites

- TrueNAS SCALE with the Apps service running and Docker's default runtime set to
  `nvidia` (it is, on this NAS), plus the NVIDIA driver installed via Apps settings.
- The ZFS pool (`tank` in the examples), and the `apps` parent dataset at `/mnt/tank/apps`.
- The existing token-managed `cloudflared` tunnel and a Cloudflare Zero Trust team.
- `ssh nas` works (key auth, your admin user, passwordless `sudo`). Remember that
  `docker`, `zfs` and `zpool` all want `sudo` on this box.
- A GHCR login for root at `/root/.docker/config.json` (present).
- A Google Cloud project for the YouTube Data API (see "Google OAuth client").

## Datasets and ownership

```text
tank/apps/cellar          -> /mnt/tank/apps/cellar          (.env lives here)
tank/apps/cellar/data     -> /mnt/tank/apps/cellar/data     -> container /data
tank/apps/cellar/media    -> /mnt/tank/apps/cellar/media    -> container /media
```

All three datasets exist, are owned `3100:3100` and are `chmod 750`.

Why uid/gid 3100: the container runs as `user: "3100:3100"`, a uid that does not
exist in the NAS OS and is not shared with any other app. The `apps` user (568)
that most TrueNAS apps run as, and every other local user, therefore cannot read
cellar's files (mode 750 gives them nothing), and cellar cannot read anyone else's.
A compromise of a neighbouring app does not expose cellar's cookie jars or
database, and the reverse holds too. Only root (and therefore `sudo` from
`admin`) can cross that line, which is why every file operation below uses `sudo`.

What each directory holds:

- `/data`: the state database (SQLite, WAL), application and per-job logs, the
  `yt-dlp` / `ffmpeg` / `ffprobe` binaries and their `<tool>.prev` rollback copies
  (`/data/bin`), thumbnails, captions, per-video metadata blobs, and scratch space
  (`/data/tmp`: cookie files, Takeout upload staging). It is not counted against any
  storage quota.
- `/media`: the first storage location. It holds only video and audio files, laid
  out as `<location>/<channelId>/<videoId>/<videoId>.<ext>`. Its quota is set in
  cellar's UI, not in ZFS.

To rebuild from scratch:

```bash
ssh nas
sudo zfs create tank/apps/cellar
sudo zfs create tank/apps/cellar/data
sudo zfs create tank/apps/cellar/media
sudo chown 3100:3100 /mnt/tank/apps/cellar /mnt/tank/apps/cellar/data /mnt/tank/apps/cellar/media
sudo chmod 750 /mnt/tank/apps/cellar /mnt/tank/apps/cellar/data /mnt/tank/apps/cellar/media
sudo install -o 3100 -g 3100 -m 0640 /dev/null /mnt/tank/apps/cellar/.env
```

Check the current state (numeric ids, because 3100 has no name):

```bash
sudo ls -lna /mnt/tank/apps/cellar
sudo zfs list -r -o name,mountpoint,used tank/apps/cellar
```

## `.env`

`/mnt/tank/apps/cellar/.env` exists, mode 0640, owned `3100`. Docker reads it as
root through `env_file`, and the container user can read it too. It is never
committed; the repo's `.env.example` is the template. Edit it with `sudo`.

| Key                                                    | How it is obtained                                                                                                          | State                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `CELLAR_SECRET_KEY`                                    | 64 hex chars, `openssl rand -hex 32`. Encrypts OAuth refresh tokens, cookie jars and proxy URLs. Back it up (see "Backup"). | generated             |
| `CF_ACCESS_TEAM_DOMAIN`                                | `<team>.cloudflareaccess.com`, the same Zero Trust team amber uses.                                                         | set                   |
| `CF_ACCESS_AUD`                                        | The Application Audience tag of the cellar host Access app (Cloudflare doc, step 1).                                        | blank, owner fills in |
| `CF_ACCESS_ALLOWED_EMAILS`                             | Owner email (comma separated list allowed). The app checks the JWT `email` claim against it.                                | must be set           |
| `GOOGLE_CLIENT_ID`                                     | From the Google OAuth client (below).                                                                                       | blank, owner fills in |
| `GOOGLE_CLIENT_SECRET`                                 | From the Google OAuth client (below).                                                                                       | blank, owner fills in |
| `PUBLIC_ORIGIN`                                        | `https://cellar.maxhogan.dev`, no trailing slash. Used for OAuth redirects and share URLs.                                  | per `.env.example`    |
| `POT_PROVIDER_URL`                                     | `http://bgutil:4416`, the sidecar in the same app. Also a UI setting.                                                       | per `.env.example`    |
| `NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES` | `all` and `video,compute,utility`.                                                                                          | per `.env.example`    |
| `PORT`, `HOST`, `DATA_DIR`, `LOG_LEVEL`                | Defaults in `.env.example` (`8080`, `0.0.0.0`, `/data`, `info`).                                                            | defaults              |

Never set `INSECURE_ALLOW_PUBLIC_ACCESS` on the NAS. It disables authentication.

Cellar refuses to start unless the three Cloudflare Access values are all set, so
until `CF_ACCESS_AUD` is filled in the container will exit and restart in a loop.
That is expected on a fresh install, not a fault. List which keys are present
without printing any value:

```bash
sudo cut -d= -f1 /mnt/tank/apps/cellar/.env | grep -v '^#' | sort
```

After any `.env` change:

```bash
sudo midclt call -j app.redeploy cellar
```

## Creating the Custom App

### Via midclt

The compose file is passed as a string. Build the JSON payload with Python so the
YAML is escaped correctly:

```bash
scp deploy/docker-compose.nas.yml nas:/tmp/cellar-compose.yml
ssh nas
sudo midclt call -j app.create "$(python3 -c '
import json, sys
print(json.dumps({
    "app_name": "cellar",
    "custom_app": True,
    "custom_compose_config_string": open(sys.argv[1]).read(),
}))' /tmp/cellar-compose.yml)"
rm /tmp/cellar-compose.yml
```

The bare shape of the call is:

```bash
sudo midclt call app.create '{"app_name":"cellar","custom_app":true,"custom_compose_config_string":"<contents of deploy/docker-compose.nas.yml>"}'
```

Inspect what TrueNAS stored with `sudo midclt call app.config cellar`.

### Via the UI

Apps -> Discover Apps -> Custom App (the three-dot menu, "Install via YAML") ->
Application Name `cellar` -> paste the contents of `deploy/docker-compose.nas.yml`
-> Save. Wait for the app to show Running. The app name must be exactly `cellar`:
it determines the tunnel's DNS alias `cellar.ix-cellar.svc.cluster.local`.

## Verifying

```bash
# containers: cellar, cellar-bgutil, cellar-watchtower, all Up (cellar healthy)
sudo docker ps --filter name=cellar --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'

# liveness, from inside the container (no ports are published)
sudo docker exec cellar curl -fsS http://127.0.0.1:8080/healthz

# logs
sudo docker logs --tail 100 cellar
sudo docker logs --tail 50 cellar-bgutil
sudo docker logs --tail 50 cellar-watchtower
```

Then run the four curl checks in
[`../docs/setup-cloudflare.md`](../docs/setup-cloudflare.md#4-verify-with-curl),
open `https://cellar.maxhogan.dev` (it should show the Access login, then the app),
and press the Self-check button: it reports every location, the database,
yt-dlp/ffmpeg versions, NVENC/NVDEC, the PO-token sidecar and each account.

## Updating

- **Application code:** merge to `main`; watchtower pulls the new `latest` within
  about two minutes. To check: `sudo docker logs --tail 20 cellar-watchtower`.
- **Force it now:** `sudo docker pull ghcr.io/pmaxhogan/cellar:latest && sudo midclt call -j app.redeploy cellar`.
- **`.env` changes:** `sudo midclt call -j app.redeploy cellar` (re-reads `env_file`).
- **Compose changes:** edit `deploy/docker-compose.nas.yml`, commit it, then push the
  new string to TrueNAS with the same payload builder as above:

  ```bash
  sudo midclt call -j app.update cellar "$(python3 -c '
  import json, sys
  print(json.dumps({"custom_compose_config_string": open(sys.argv[1]).read()}))' /tmp/cellar-compose.yml)"
  ```

  Or Apps -> cellar -> Edit in the UI. Never run `docker compose up -d` by hand: the
  Apps middleware owns the project and will fight it.

yt-dlp and ffmpeg are not part of image updates. The image only ships a baseline copy
under `/opt/cellar/bin`; at boot the server copies it into `/data/bin` when a tool is
absent there (a copy already in `/data/bin` is never overwritten, so an update survives
a restart and a redeploy), and a daily check (the first one 5 minutes after boot)
downloads newer verified builds into `/data/bin`. The About page shows the installed
versions and has a manual update button.

- **The ffmpeg pin.** ffmpeg comes from BtbN's builds, from the release named by the
  `tools.ffmpeg_release_tag` setting (Settings -> Tools). The default is a pinned dated
  release (`autobuild-2025-12-31-14-28`, the one the image ships), not `latest`: builds
  from early 2026 on are linked against NVENC API 13.1, which needs NVIDIA driver 610 or
  newer, and on an older driver (this NAS runs 580) they list `hevc_nvenc` and then fail to
  open an encoder, so every transcode would silently fall back to slow software encoding.
  Set the tag to `latest` only after the NAS driver is new enough. As a second line of
  defence, an update whose staged ffmpeg cannot open an NVENC encoder that the current
  one can is refused (outcome `blocked`, shown on About and in Self-check) and is not
  downloaded again until you force an update.
- **The first update check downloads the pinned ffmpeg once.** The image's baseline has
  no recorded build date, so the first check installs the pinned release over it (about
  80 MB, checksum-verified) even though it is the same release; later checks say it is up
  to date until you change the tag.
- **Rollback files.** Every update first hard links the live binary to `<tool>.prev` in
  `/data/bin` (`yt-dlp.prev`, `ffmpeg.prev`, `ffprobe.prev`), then renames the new file
  over the live path, so the live path never goes missing. About -> roll back (or
  `POST /api/tools/rollback`) swaps the `.prev` back in; it answers 412 when there is no
  `.prev`. After a rollback the release you rolled away from is not reinstalled until you
  force an update. `/data/bin/.staging` is scratch space and is deleted after each check.

## Scratch space for yt-dlp (`/run/ytdlp`)

The root filesystem is read-only and `/tmp` is a `noexec` tmpfs. The `yt-dlp_linux`
binary is a PyInstaller onefile build that unpacks itself (about 45 MB) into `$TMPDIR` on
every run, so the compose file mounts one dedicated executable tmpfs and points `TMPDIR`
at it:

```yaml
tmpfs:
  - /run/ytdlp:size=1g,uid=3100,gid=3100,mode=0700,exec
environment:
  TMPDIR: /run/ytdlp
```

It is 1 GB because a yt-dlp that is killed mid-run leaves its `_MEI*` directory behind and
enough of them fill the mount, after which every run fails. Cellar removes orphans itself:
before each yt-dlp run it deletes `_MEI*` directories older than 10 minutes that no
running process has mapped. If you still see `No space left on device` from yt-dlp, look
inside with `sudo docker exec cellar du -sh /run/ytdlp` and restart the app
(`sudo midclt call -j app.redeploy cellar`), which empties the tmpfs. Do not add `exec`
to any other mount.

## Adding a second storage location

A location is a bind mount plus a database row, so it takes both.

1. Create and own the directory or dataset on the NAS, with the same ownership as
   the first one:

   ```bash
   sudo zfs create alpha/cold/cellar        # or any directory you prefer
   sudo chown 3100:3100 /mnt/tank/cold/cellar
   sudo chmod 750 /mnt/tank/cold/cellar
   ```

2. Add the mount under the `cellar` service's `volumes` in
   `deploy/docker-compose.nas.yml` and push it with `app.update`:

   ```yaml
   volumes:
     - /mnt/tank/apps/cellar/data:/data
     - /mnt/tank/apps/cellar/media:/media
     - /mnt/tank/cold/cellar:/media2
   ```

   The root filesystem is read-only, so a location must be a mount; cellar cannot
   create new top-level paths.

3. In the UI, open Locations, add `/media2` with a label and a quota in GB, and
   enable it. Quotas are enforced by cellar, per location (reaping starts at 95% of
   quota or under 10 GB free, down to 90%), not by ZFS.
4. Point rules at the new location. A video whose rule now resolves to a different
   location is moved, not re-downloaded.

## GPU notes

- The NAS has a GTX 1650 SUPER (Turing, driver 580.x): NVENC H.264 and HEVC, NVDEC,
  and no AV1 encode. Cellar downloads AV1 when YouTube offers it, and otherwise
  transcodes to `hevc_nvenc`. Software SVT-AV1 exists as a rule option and is not the
  default.
- The compose reserves the GPU the same way the mkvid app does
  (`capabilities: [gpu, video]`, `driver: nvidia`, `count: all`), and Docker's
  default runtime on the NAS is `nvidia`. mkvid uses the same card, so the default of
  one concurrent transcode keeps the two from fighting.
- The read-only root filesystem with `tmpfs` on `/tmp` and `cap_drop: ALL` was
  verified to work with the nvidia runtime on this NAS.
- Cellar probes NVENC/NVDEC at runtime and falls back to CPU; the Self-check page
  says what it found, and GPU codecs are only offered in the rule UI when present. The
  probe is a 10 frame test encode per encoder, not just the encoder list, because an
  ffmpeg built for a newer NVENC API than the driver offers lists the encoders and then
  cannot open one. That is why ffmpeg is pinned (see "Updating"); when the encoder is
  unavailable, transcodes fall back to software SVT-AV1 at preset 8, CRF 35, under
  `nice 19`, and an activity row says so.

## Google OAuth client

Cellar uses one OAuth client for all linked accounts; each account gets its own
refresh token. Do this once in the Google Cloud console (reuse a project or create
one):

1. APIs and Services -> Library -> enable **YouTube Data API v3**.
2. APIs and Services -> OAuth consent screen -> user type **External**. App name and
   support/developer emails are yours. Add the scope
   `https://www.googleapis.com/auth/youtube.readonly`.
3. **Publish the app to Production** (Publishing status -> Publish app). Do not leave
   it in Testing: in Testing mode Google expires refresh tokens after 7 days and
   every linked account would silently stop syncing weekly. An unverified-app warning
   at consent time is fine for a personal app; click through Advanced.
4. Credentials -> Create credentials -> OAuth client ID -> type **Web application**.
   Authorized redirect URI, exactly:

   ```text
   https://cellar.maxhogan.dev/api/oauth/google/callback
   ```

5. Copy the client id and secret into `/mnt/tank/apps/cellar/.env` as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then
   `sudo midclt call -j app.redeploy cellar`.
6. In cellar: Accounts -> link account -> complete the Google consent. The default
   quota is 10,000 units a day per project; cellar tracks it and never calls
   `search.list`.

## Cookies export

Linking an account needs both the OAuth consent and a `cookies.txt` jar: watch
history, Watch Later and every download go through yt-dlp with the account's cookies.

1. In the browser profile signed into the YouTube account, install the **Get
   cookies.txt LOCALLY** extension.
2. Open `https://www.youtube.com` (signed in), click the extension, and export in
   **Netscape** format for `youtube.com`. Prefer exporting from a private window
   that you close straight afterwards, as yt-dlp's own guidance does, so the browser
   does not keep rotating the cookies you exported.
3. In cellar: Accounts -> the account -> paste the file contents -> save. Cellar
   validates the jar by running the history feed once with
   `--flat-playlist --playlist-end 1`.

Cookies are stored AES-256-GCM encrypted under `CELLAR_SECRET_KEY`. For each yt-dlp
run the jar is decrypted to a 0600 file under `/data/tmp`, used, deleted, and the
refreshed jar (YouTube rotates cookies) is written back encrypted. Treat the jar as
the account's login: if it leaks, sign out of all sessions for that Google account.

## Takeout export

Optional, but it is how you seed years of history in one go.

1. Go to `https://takeout.google.com`, deselect everything, then select **YouTube and
   YouTube Music**.
2. Under "All YouTube data included", choose only what you want: **history**,
   **playlists** (Watch Later, Liked) and **subscriptions**.
3. Under "Multiple formats", set history to **JSON** (the other items export as CSV).
4. Export once, download the archive (`.zip` or `.tgz`).
5. In cellar: the Takeout page -> choose the account to import into, then upload the
   archive, or the individual `watch-history.json` / playlist CSVs / `subscriptions.csv`
   from inside it. Cellar accepts `.zip`, `.tgz` / `.tar.gz` and loose `.json` / `.csv`
   files, up to 2 GB per request. It answers with a preview (rows per file, what will be
   skipped) and starts the import as a background job. The import is idempotent
   and logged as an activity with counts: re-uploading the same export creates nothing, and
   a video's first-seen time only ever moves earlier. Entries without a video URL (ads,
   removed videos) are skipped and counted. Only Watch Later and Liked videos become
   sources; other playlists are counted but not imported. Unknown videos become
   metadata-only records and are queued for a recheck; your rules decide whether to
   download them.

**Upload size.** Cloudflare caps one proxied request body at 100 MB on the Free and Pro
plans, far below cellar's own 2 GB limit, so a large archive uploaded through the public
hostname fails at the edge before cellar sees it. Upload the loose files from inside the
archive instead (the history JSON, the playlist CSVs and `subscriptions.csv` are usually
far smaller than the archive), one request each if needed.

Failures come back as readable errors: "history exported as HTML" (re-export with history
as JSON), "no Takeout files found", an unreadable `.tgz` / `.zip`, or an archive with a
path outside itself (refused whole, nothing imported).

Menu labels at Google change from time to time; the content to pick is history,
playlists and subscriptions, with history as JSON.

## Backup and restore

| Path                         | Contents                                                                         | Reproducible?                                       |
| ---------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| `/data`                      | State DB (rules, accounts, share links, history, metadata timeline), logs, tools | **No.** This is the thing to back up.               |
| `/media`                     | Video and audio files                                                            | Mostly: re-downloadable, except for deleted videos. |
| `/mnt/tank/apps/cellar/.env` | `CELLAR_SECRET_KEY`, Access values, Google client                                | **No** for the secret key. Keep a copy off the NAS. |

- Without `CELLAR_SECRET_KEY` the encrypted columns in a restored `/data` are
  unreadable: you would have to re-link every account, re-paste cookies and re-enter
  proxies. Store the key in a password manager, separately from the data backup.
- `/media` is reproducible in the sense that cellar can re-download what the rules
  select, and the reaper deliberately deletes media it may later re-download. It is
  not reproducible for videos YouTube has since removed or made private, and priority
  0 media is never re-downloaded after it is gone. If those matter, snapshot `/media`
  too; otherwise a lost `media` dataset is only bandwidth and time.
- Snapshot `data` (cheap, and the database runs with `synchronous=FULL` in WAL mode,
  so a snapshot of a running app is crash-consistent):

  ```bash
  sudo zfs snapshot tank/apps/cellar/data@$(date +%Y%m%d-%H%M)
  ```

  A TrueNAS periodic snapshot task on `tank/apps/cellar/data` with replication to
  another pool or machine is the durable version of the same thing.

- Restore: stop the app (`sudo midclt call -j app.stop cellar`), roll back or copy the
  snapshot into `/mnt/tank/apps/cellar/data` (`sudo zfs rollback` or
  `sudo rsync -a /mnt/tank/apps/cellar/data/.zfs/snapshot/<name>/ /mnt/tank/apps/cellar/data/`),
  make sure ownership is still `3100:3100`, restore `.env` with the same
  `CELLAR_SECRET_KEY`, and `sudo midclt call -j app.start cellar`.
- Rebuilding on a new machine is: datasets, `.env`, `app.create`, restore `/data`.
  Run Self-check afterwards; missing media files show up as locations that disagree
  with the database, and the rules re-fetch what they should.

## Troubleshooting

**Permission denied on `/data` or `/media`.** Look at the numeric owner:
`sudo ls -lnd /mnt/tank/apps/cellar/data /mnt/tank/apps/cellar/media`. Both must
be `3100 3100` and `drwxr-x---`. If a restore, `rsync` or a TrueNAS UI permission
edit reset them, fix with `sudo chown -R 3100:3100 /mnt/tank/apps/cellar/{data,media}`
and `sudo chmod 750` on the directories, then `sudo midclt call -j app.redeploy cellar`.
Do not "fix" it by loosening to 755 or chowning to `apps`. If `chmod` seems to have no
effect, the dataset may carry an NFSv4 ACL: check `sudo zfs get acltype,aclmode` on it.
`sudo` is needed even to look, because `admin` (3000) has no access by design.

**GPU not visible.** Check in order: the host sees it (`nvidia-smi` on the NAS, and
Apps -> Settings has the NVIDIA drivers installed); the container sees it
(`sudo docker exec cellar nvidia-smi`, which needs `utility` in
`NVIDIA_DRIVER_CAPABILITIES`; `video` is needed for NVENC); the compose still has the
`deploy.resources.reservations.devices` block (an `app.update` with an older string
drops it); and the Self-check page's NVENC/NVDEC line. If the container has no GPU,
cellar falls back to CPU transcoding rather than failing.

**bgutil unreachable.** `sudo docker ps --filter name=bgutil` should show it Up;
`sudo docker logs --tail 50 cellar-bgutil` shows why not. From the app's side:
`sudo docker exec cellar curl -fsS http://bgutil:4416/ping`. The name `bgutil`
only resolves inside the app's own compose network, so a `POT_PROVIDER_URL` pointing
anywhere else, or a sidecar renamed in the compose file, breaks it. Downloads can
still work without a PO token, but YouTube's bot wall will trip far more often.

**Access 403 / 401 / redirect loops.**

- A Cloudflare-branded "access denied" (403) page means the Allow policy does not
  include the email you signed in with.
- A JSON `401` from cellar itself means Cloudflare let you in but the app rejected
  the token: wrong `CF_ACCESS_AUD` (copied from the wrong app, for example the
  bypass app), `CF_ACCESS_TEAM_DOMAIN` with a scheme or trailing slash, an email not
  in `CF_ACCESS_ALLOWED_EMAILS`, or a clock skew above the 30 s tolerance
  (`date` on the NAS). Fix `.env` and redeploy.
- A redirect loop on `/` usually means the host Access app and a second app overlap:
  the bypass app must be scoped to path `s`, never to the whole host.
- A share link that redirects to the Access login instead of showing the page: the
  bypass app is missing, mis-pathed, or still propagating (wait a few minutes).
- 502 from Cloudflare: the tunnel origin is wrong. It must be
  `http://cellar.ix-cellar.svc.cluster.local:8080`; a bare `http://cellar:8080` does
  not resolve.

**yt-dlp fails with "No space left on device".** The exec tmpfs `/run/ytdlp` is full of
`_MEI*` directories from killed runs (see "Scratch space for yt-dlp"). Cellar prunes
orphans older than 10 minutes before each feed run; a redeploy
(`sudo midclt call -j app.redeploy cellar`) empties the mount.

**Transcodes are slow and Activity says SVT-AV1 fallback.** NVENC does not open on this
driver. Check the Self-check page's NVENC line and the ffmpeg build on About: a build
newer than the pin needs driver 610 or newer. Set `tools.ffmpeg_release_tag` back to the
default (`autobuild-2025-12-31-14-28`) and run About -> update, or roll ffmpeg back.

**A Takeout upload fails right away or never finishes.** If the browser reports a network
error or a Cloudflare error page for a big file, it hit Cloudflare's 100 MB request
limit: upload the loose files from the archive instead (see "Takeout export").

**Container restarts in a loop.** `sudo docker logs --tail 50 cellar`. On a new install
it is almost always a missing `CF_ACCESS_AUD` or a malformed `CELLAR_SECRET_KEY`
(not exactly 64 hex characters).
