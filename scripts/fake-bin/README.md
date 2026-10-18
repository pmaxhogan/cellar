# fake-bin

Fake `yt-dlp`, `ffmpeg` and `ffprobe` for integration tests of the job runner. They need no
network, GPU or real binaries. Each tool is a Node ESM script (`<tool>.mjs`) plus two thin
launchers: `<tool>` (POSIX `sh`, executable bit set) and `<tool>.cmd` (Windows). The shared
code is in `lib.mjs`; the canned yt-dlp data is in `ytdlp-data.mjs`.

Behaviour is driven by environment variables and, for per-call scripting, a JSON scenario.
The shims are meant to be spawned with an argv array and no shell.

## Putting the shims on PATH

```ts
import { delimiter, join } from "node:path";

const fakeBin = join(repoRoot, "scripts", "fake-bin");
process.env.PATH = fakeBin + delimiter + process.env.PATH;
// A plain spawn("yt-dlp", argv) now runs the sh launcher on Linux and macOS.
```

The launchers run `node` from PATH. Set `FAKE_BIN_NODE` to an absolute node binary (for
example `process.execPath`) when `node` is not on PATH in the test environment.

### Windows

Node cannot start a `.cmd` without a shell (`spawn EINVAL`), and libuv only appends `.exe`
when it searches PATH, so `spawn("yt-dlp")` does not find `yt-dlp.cmd` on Windows. cmd.exe
also misreads unquoted `<`, `^` and `&` in arguments such as the `-f` format selector. For
local runs on Windows spawn the Node script directly, and make the tool paths configurable in
the code under test:

```ts
spawn(process.execPath, [join(fakeBin, "yt-dlp.mjs"), ...argv]);
```

`yt-dlp.cmd` is still useful for a human at a terminal and for simple argument lists
(`cmd.exe /d /s /c yt-dlp.cmd --version`). Linux CI uses the `sh` launchers unchanged.

## Common mechanics

- `FAKE_<TOOL>_RECORD=<path>` (`YTDLP`, `FFMPEG`, `FFPROBE`): appends the argv of every
  invocation, including `--version`, as one JSON array per line. Cookie jar contents are never
  printed or recorded; the `--cookies` path is in the argv.
- `FAKE_<TOOL>_SCENARIO`: inline JSON (starts with `{`) or a path to a JSON file. Its keys
  override the env vars and use the camelCase names listed below (`failIds`, `delayMs`, ...).
  A `calls` array selects an entry per invocation: the entry replaces keys of the base
  scenario for that call, and the last entry repeats once the list is exhausted.
- `FAKE_<TOOL>_STATE=<path>`: file used as the call counter for `calls`. Each substantive
  invocation appends one byte; `--version`, `--help`, `-encoders` and the like do not count.
  Without it every call uses `calls[0]`. Concurrent invocations can race on the counter, so
  use per-id scenario keys when downloads run in parallel.
- `FAKE_BIN_NODE`: node executable used by the launchers.

## yt-dlp

Arguments are parsed like yt-dlp's: `--flag value`, `--flag=value`, short aliases (`-o`, `-f`,
`-J`, `-x`, `-q`, `-I`, `-P`), unknown flags are ignored, anything else is a URL. The video id
comes from `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/` or a bare 11 character id.

| Invocation                                                  | Behaviour                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--version`                                                 | Prints `2026.08.19-fake`.                                                                                                                                    |
| `--help`                                                    | Help text that includes `--js-runtimes`, `--extractor-args`, `--cookies`, `--live-from-start` and the other flags cellar uses.                               |
| `-J` / `--dump-single-json` / `-j` plus a playlist/feed URL | One flat playlist JSON document. `--playlist-end N` and `-I a:b` trim it. `feed/history` and `:ythistory` report id `history`, `:ytwatchlater` reports `WL`. |
| `-J` plus a video URL                                       | The full info dict (formats, subtitles, thumbnails) for that id.                                                                                             |
| a download (`-o <template>` plus any of the flags below)    | Creates the files, prints progress and optional JSON, writes the cookie jar back.                                                                            |

Download details:

- `-o` is expanded for `%(id)s`, `%(ext)s`, `%(title)s`, `%(channel_id)s` and every other info
  field. `-P <dir>` is prepended. Parent directories are created.
- Media file: a `.webm` (av01, vp09) or `.mp4` (avc1) of `FAKE_YTDLP_BYTES` random bytes
  (default 65536). `-f ba` writes `.webm`, `-x` writes `.opus` (or `--audio-format`),
  `--merge-output-format` or `--remux-video` override the extension, `--skip-download` and
  `--simulate` write no media. `height<=N` in the `-f` selector caps the reported height.
  `--no-overwrites` skips an existing media file.
- Sidecars, only when asked for: `--write-info-json` writes `<base>.info.json`;
  `--write-subs` / `--write-auto-subs` write `<base>.<lang>.vtt` for each `--sub-langs` entry
  (default `en`; `all` or a pattern gives `en` and `es`); `--write-thumbnail` writes
  `<base>.jpg`; `--write-all-thumbnails` additionally writes `<base>.<variant>.jpg` for
  `default`, `mqdefault`, `hqdefault`, `sddefault`, `hq720` and `maxresdefault`. Thumbnail
  bytes are deterministic per id and variant, so hashes are stable between runs. (Real yt-dlp
  would write either `<base>.jpg` or the variants, not both.)
- stdout: yt-dlp style `[youtube]`, `[info]` and `[download]` progress lines (suppressed by
  `-q` and `--no-progress`), then with `--print-json` one line of info JSON, which includes
  `_filename`, `filename` and `requested_downloads[0].filepath`. `--print TEMPLATE` prints
  the expanded template (`filepath` is available as a field, `%()j` is the whole JSON).
- Cookies: with `--cookies <file>` the file is rewritten on exit, also after a failure and
  also for listing runs, like yt-dlp's cookie jar save. One cookie line named
  `FAKE_ROTATED_<n>` is appended and the first cookie with a non-zero expiry is bumped by one
  day. A missing or empty file gets a Netscape header. A file that is not Netscape format fails
  with `'<path>' does not look like a Netscape format cookies file` and exit 1.
- Errors: exit 2 with a usage message when no URL is given.

Environment variables (scenario key in parentheses):

| Variable                   | Scenario key   | Meaning                                                                                                                            |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `FAKE_YTDLP_RECORD`        | n/a            | Append every argv as a JSON line to this file.                                                                                     |
| `FAKE_YTDLP_FAIL`          | `fail`         | `1` makes every id fail: `ERROR: [youtube] <id>: Sign in to confirm you're not a bot`, exit 1. Listings fail with `[youtube:tab]`. |
| `FAKE_YTDLP_FAIL_IDS`      | `failIds`      | Comma separated ids that fail; other ids in the same call still download. Exit code is 1 if any failed.                            |
| `FAKE_YTDLP_FAIL_MESSAGE`  | `failMessage`  | Replaces the text after `ERROR: [youtube] <id>: `.                                                                                 |
| `FAKE_YTDLP_FAIL_EXIT`     | `failExit`     | Exit code for failures (default 1).                                                                                                |
| `FAKE_YTDLP_VCODEC`        | `vcodec`       | `av01` (default, `.webm`), `vp09` (`.webm`) or `avc1` (`.mp4`). Aliases `av1`, `vp9`, `h264` work.                                 |
| `FAKE_YTDLP_BYTES`         | `bytes`        | Size of the dummy media file (default 65536).                                                                                      |
| `FAKE_YTDLP_PLAYLIST_FILE` | `playlistFile` | JSON file served for every playlist or feed URL: a full playlist object or a bare array of entries. Default is 3 entries.          |
| `FAKE_YTDLP_DELAY_MS`      | `delayMs`      | Total time spent in the progress lines of each download, to test cancellation and concurrency.                                     |
| `FAKE_YTDLP_SCENARIO`      | n/a            | Inline JSON or file path, see below.                                                                                               |
| `FAKE_YTDLP_STATE`         | n/a            | Call counter file for `calls`.                                                                                                     |

Scenario-only keys: `ids` (map of video id to `{ fail, error, bytes, vcodec, delayMs, info }`;
`error` is the message text and implies failure, `info` is merged into the printed info
dict), `playlist` (inline entries array or playlist object, instead of a file), `stderr` (a
line written to stderr on every substantive call), and `calls`.

Default flat playlist ids: `dQw4w9WgXcQ`, `jNQXAC9IVRw`, `9bZkp7q19f0`. Other known ids with
real titles and channels: `aircAruvnKk`, `WUvTyaaNkzM`, `IHZwWFHWa-w` (3Blue1Brown) and
`HeQX2HjkcNo` (Veritasium). Any other id gets a stable synthetic title and channel.

## ffprobe

Supports `-version` and
`ffprobe -v error -print_format json -show_format -show_streams <file>`. `-show_streams` and
`-show_format` each add their section; `-select_streams v|a|v:0|a:0` filters streams. The
file is only stat-ed for `format.size` and `format.bit_rate`, never read.

| Variable                    | Scenario key  | Meaning                                                                                   |
| --------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `FAKE_FFPROBE_RECORD`       | n/a           | Append every argv as a JSON line.                                                         |
| `FAKE_FFPROBE_VCODEC`       | `vcodec`      | Video `codec_name`: `av1` (default), `hevc`, `h264` or `vp9`.                             |
| `FAKE_FFPROBE_DURATION`     | `duration`    | `format.duration` in seconds (default `212.5`).                                           |
| `FAKE_FFPROBE_FAIL`         | `fail`        | `1` prints `Invalid data found when processing input` and exits 1.                        |
| `FAKE_FFPROBE_REQUIRE_FILE` | `requireFile` | Default true: a missing file fails with `No such file or directory`. `0` skips the check. |
| `FAKE_FFPROBE_SCENARIO`     | n/a           | Inline JSON or file path.                                                                 |
| `FAKE_FFPROBE_STATE`        | n/a           | Call counter file for `calls`.                                                            |

Scenario-only keys: `width`, `height`, `frameRate` (for example `"30/1"`), `acodec` (`opus`
or `aac`), `noVideo`, `noAudio` (drop a stream, to test "streams present" checks), `byFile`
(map of file basename to a set of overrides, to make the source and the output differ) and
`calls`.

The default output has one video stream (`av1`, 1920x1080, `r_frame_rate` `30/1`), one audio
stream (`opus`), and `format_name` chosen from the file extension.

## ffmpeg

- `-version`: prints `ffmpeg version 7.1-fake ...` and a banner.
- `-encoders`: always lists `libx264`, `libx265`, `libsvtav1`, `libopus` and `aac`; also
  `hevc_nvenc` and `h264_nvenc` when `FAKE_FFMPEG_NVENC=1`.
- `-decoders`: software decoders; `*_cuvid` decoders when `FAKE_FFMPEG_NVENC=1`.
- `-hwaccels`: `Hardware acceleration methods:` plus `cuda` when `FAKE_FFMPEG_NVENC=1`.
- Transcode (`-i in ... out`): the input is copied to the output path, or `FAKE_FFMPEG_BYTES`
  random bytes are written instead. Like the real tool it exits 254 for a missing input or a
  missing output directory, and exits 1 (`File '<out>' already exists. Exiting.`) when the
  output exists and `-y` is absent. `-f lavfi` inputs (an NVENC probe encode) need no input
  file, and an output of `-`, `-f null`, `NUL` or `/dev/null` writes nothing.
- stderr gets a banner, `Input #0` / `Duration:` / `Output #0` lines and four
  `frame=... fps=... size=... time=HH:MM:SS.cc bitrate=... speed=...` progress lines
  terminated by `\r` (the last by `\n`), like real ffmpeg. `-hide_banner`, `-nostats` and
  `-loglevel error|quiet` suppress the respective parts. `-progress pipe:1`, `pipe:2` or a file
  path additionally receive the `key=value` blocks ending in `progress=continue` / `end`.
  `Duration:` and the progress times use `FAKE_FFPROBE_DURATION` (default 212.5).

| Variable               | Scenario key | Meaning                                                                                                                                                                                    |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FAKE_FFMPEG_RECORD`   | n/a          | Append every argv as a JSON line.                                                                                                                                                          |
| `FAKE_FFMPEG_NVENC`    | `nvenc`      | `1` advertises NVENC in `-encoders`, `-decoders` and `-hwaccels`. `0` additionally makes encodes using `*_nvenc` or `-hwaccel cuda` fail. Unset: not advertised, but such encodes succeed. |
| `FAKE_FFMPEG_FAIL`     | `fail`       | `1` fails the transcode: `Error while opening encoder for output stream #0:0 ...`, `Conversion failed!`, exit 1, no output file.                                                           |
| `FAKE_FFMPEG_BYTES`    | `bytes`      | Write this many random bytes to the output instead of copying the input.                                                                                                                   |
| `FAKE_FFMPEG_DELAY_MS` | `delayMs`    | Total delay spread across the progress lines, to test cancellation.                                                                                                                        |
| `FAKE_FFMPEG_SCENARIO` | n/a          | Inline JSON or file path.                                                                                                                                                                  |
| `FAKE_FFMPEG_STATE`    | n/a          | Call counter file for `calls`.                                                                                                                                                             |

Scenario-only keys: `duration` (seconds), `leavePartial` (with `fail`, leave a zero byte
output file behind, to test cleanup) and `calls`.

## Per-call scenario example

First download hits a bot wall, the retry succeeds:

```ts
process.env.FAKE_YTDLP_SCENARIO = JSON.stringify({
  calls: [{ fail: true }, {}],
});
process.env.FAKE_YTDLP_STATE = join(tmp, "ytdlp.calls");
```

## Tests

`server/test/fakeBin.test.ts` exercises every behaviour above. It spawns the sh launcher on
POSIX and the `.mjs` through `process.execPath` on Windows, plus a launcher smoke test on
both (`cmd.exe /d /s /c <tool>.cmd` on Windows).
