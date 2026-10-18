# Test fixtures

Synthetic JSON fixtures for the YouTube Data API v3, Return YouTube Dislike and yt-dlp.

## How they were synthesised

No real account data, no live API calls. The field names, nesting, string-vs-number types,
`kind` values and pagination fields follow the public API reference for each endpoint
(`videos.list`, `playlistItems.list`, `subscriptions.list`, `channels.list`, the standard
error envelope) and yt-dlp's `--dump-single-json` output. All numbers (view counts, likes,
durations, timestamps, etags, item ids, page tokens) are invented. Only well-known public
videos and channels are used:

- Rick Astley: video `dQw4w9WgXcQ`, channel `UCuAXFkgsw1L7xaCfnd5JJOw`
- "Me at the zoo": video `jNQXAC9IVRw`, channel `UC4QobU6STFB0P71PMvOGN5A`
- 3Blue1Brown: channel `UCYO_jab_esuFRV4b17AJtAw`, videos `aircAruvnKk`, `WUvTyaaNkzM`,
  `IHZwWFHWa-w`
- Veritasium: channel `UCHnyfMqiRRG1u-2MsSQLbXA`, video `HeQX2HjkcNo`
- PSY: video `9bZkp7q19f0` (watch later list only)

The "account" that owns the liked playlist and the subscriptions is invented:
channel `UCFakeAccountChannel0001`, handle `@fakeaccount`. `pRiVaTe0001` is a synthetic id used
for a private or deleted entry.

Some states are deliberately not true of the real video: `jNQXAC9IVRw` is marked `unlisted`
and `aircAruvnKk` is an upcoming premiere in `videos.list.json`, to cover those code paths.

The files are generated with `scripts/fake-bin/ytdlp-data.mjs` (the same builders the fake
yt-dlp uses) plus a one-off script, then formatted with Prettier. They are static; edit the
JSON directly when a test needs a different shape, and keep `server/test/fixtures.test.ts`
passing. Everything is ASCII.

## youtube/

Every file is the response body of one API call unless noted.

| File                            | Request it stands for                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `videos.list.json`              | `videos.list?part=snippet,contentDetails,statistics,status,liveStreamingDetails,topicDetails&id=dQw4w9WgXcQ,jNQXAC9IVRw,aircAruvnKk`. Three items: public, `unlisted`, and an upcoming premiere (`liveBroadcastContent: "upcoming"`, `duration: "P0D"`, `liveStreamingDetails.scheduledStartTime`). Counters are strings, as in the real API. `pageInfo` is `{ totalResults: 3, resultsPerPage: 3 }`. |
| `videos.list.missing.json`      | The same request, where the third id (`aircAruvnKk`) is gone: three ids requested, two items returned, `pageInfo.totalResults` 2. The API gives no per-id error, a missing id is simply absent.                                                                                                                                                                                                       |
| `playlistItems.list.LL.json`    | A JSON array of TWO response bodies for `playlistItems.list?playlistId=LL&part=snippet,contentDetails,status&maxResults=3`: page one has `nextPageToken`, page two has `prevPageToken` and no `nextPageToken`. `snippet.publishedAt` is the like time, newest first. The last item is a deleted video (`title: "Deleted video"`, no `videoOwnerChannelId`). `pageInfo.totalResults` is 5.             |
| `playlistItems.list.UU.json`    | `playlistItems.list?playlistId=UUYO_jab_esuFRV4b17AJtAw`: the uploads playlist of 3Blue1Brown, newest first, three items, no `nextPageToken`.                                                                                                                                                                                                                                                         |
| `subscriptions.list.json`       | `subscriptions.list?mine=true&part=snippet,contentDetails`: two subscriptions (3Blue1Brown, Veritasium). `snippet.publishedAt` is the subscribe date, `snippet.resourceId.channelId` is the subscribed channel.                                                                                                                                                                                       |
| `channels.list.mine.json`       | `channels.list?mine=true&part=snippet,contentDetails,statistics`: the invented account; `contentDetails.relatedPlaylists` gives `likes: "LL"` and `uploads: "UUFakeAccountChannel0001"`.                                                                                                                                                                                                              |
| `error.quotaExceeded.json`      | HTTP 403 body, `reason: "quotaExceeded"`, `domain: "youtube.quota"`. Whole-batch outage signal, not a per-video failure.                                                                                                                                                                                                                                                                              |
| `error.invalidCredentials.json` | HTTP 401 body, `reason: "authError"`, `status: "UNAUTHENTICATED"`. Triggers a token refresh.                                                                                                                                                                                                                                                                                                          |
| `ryd.votes.json`                | `https://returnyoutubedislikeapi.com/votes?videoId=dQw4w9WgXcQ`: `id`, `dateCreated`, `likes`, `dislikes`, `rating`, `viewCount`, `deleted`. Numbers here are JSON numbers, unlike the YouTube API.                                                                                                                                                                                                   |

## ytdlp/

| File                   | Command it stands for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history.flat.json`    | `yt-dlp -J --flat-playlist https://www.youtube.com/feed/history`: five `url` entries including `pRiVaTe0001` with `title: "[Private video]"`, `duration: null` and null channel fields. Top-level `id` is `history`. The URL form is handled by the `youtube:tab` extractor, which is what `extractor` says.                                                                                                                                                                                                                  |
| `watchlater.flat.json` | `yt-dlp -J --flat-playlist :ytwatchlater`: three entries, top-level `id` `WL`, title `Watch later`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `info.full.json`       | `yt-dlp --dump-single-json https://www.youtube.com/watch?v=dQw4w9WgXcQ` after format selection. A `formats` array with storyboards, audio (`139`, `140` m4a; `249`, `250`, `251` opus), a combined `18`, and video at 720p and 1080p for `av01` (`398`, `399`), `vp09` (`247`, `248`) and `avc1` (`136`, `137`); `subtitles`, `automatic_captions`, the six standard `thumbnails` variants, `live_status: "not_live"`, `availability: "public"`, and `requested_downloads`. Stream URLs are fake `googlevideo.com` addresses. |

## Using them with the shims

`FAKE_YTDLP_PLAYLIST_FILE=server/test/fixtures/ytdlp/history.flat.json` makes the fake
yt-dlp return the history fixture for any flat playlist call. See
`scripts/fake-bin/README.md`.
