import { describe, expect, it } from "vitest";
import {
  canonicalWatchUrl,
  isChannelId,
  isVideoId,
  parseChannelRef,
  parseVideoId,
} from "../src/idParser.ts";

const ID = "dQw4w9WgXcQ";
const ID2 = "jNQXAC9IVRw";
const ID3 = "9bZkp7q19f0";
const DASH_ID = "_-aB3dE-f_9";
const CHANNEL = "UCuAXFkgsw1L7xaCfnd5JJOw";

describe("parseVideoId accepts every identifier form", () => {
  const accepted: [string, string][] = [
    [`http://www.youtube.com/watch?v=${ID}`, ID],
    [`http://youtube.com/watch?v=${ID}`, ID],
    [`https://youtube.com/watch?v=${ID}`, ID],
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`youtube.com/watch?v=${ID}`, ID],
    [`www.youtube.com/watch?v=${ID}`, ID],
    [`//www.youtube.com/watch?v=${ID}`, ID],
    [`HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`, ID],
    [`youtu.be/${ID}`, ID],
    [`https://youtu.be/${ID}`, ID],
    [`https://youtu.be/${ID}?si=AbCdEfGh123&t=42`, ID],
    [`youtu.be/watch?v=${ID}&t=124&_sp=abc.def`, ID],
    [`https://www.youtube.com/watch?v=${ID}&t=124&_sp=xyz`, ID],
    [`https://www.youtube.com/watch?feature=share&v=${ID}`, ID],
    [`https://www.youtube.com/watch?app=desktop&feature=youtu.be&v=${ID}&pp=ygU`, ID],
    [`https://www.youtube.com/watch?v=${ID}&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI&index=2`, ID],
    [`https://www.youtube.com/watch?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI&v=${ID}`, ID],
    [`https://www.youtube.com/watch?v=${ID}#t=30`, ID],
    [`https://www.youtube.com/watch/?v=${ID}`, ID],
    [`https://www.youtube.com/?v=${ID}`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`https://youtube.com/shorts/${ID}?feature=share`, ID],
    [`https://www.youtube.com/shorts/${ID}/`, ID],
    [`https://www.youtube.com/live/${ID}?si=xyz`, ID],
    [`https://www.youtube.com/embed/${ID}`, ID],
    [`https://www.youtube.com/embed/${ID}?start=10&autoplay=1`, ID],
    [`https://www.youtube-nocookie.com/embed/${ID}`, ID],
    [`https://www.youtube.com/v/${ID}?version=3`, ID],
    [`https://www.youtube.com/e/${ID}`, ID],
    [`https://www.youtube.com/watch/${ID}`, ID],
    [`https://music.youtube.com/watch?v=${ID}&feature=share`, ID],
    [`https://m.youtube.com/watch?v=${ID}`, ID],
    [`m.youtube.com/shorts/${ID}`, ID],
    [`https://www.youtube.com:443/watch?v=${ID}`, ID],
    [`https://www.youtube.com/watch?v=${ID2}`, ID2],
    [`https://youtu.be/${ID3}`, ID3],
    [`https://www.youtube.com/watch?v=${DASH_ID}`, DASH_ID],
    [ID, ID],
    [DASH_ID, DASH_ID],
    [`   ${ID}  `, ID],
    [`\n\thttps://youtu.be/${ID}\n`, ID],
  ];

  it.each(accepted)("%s", (input, expected) => {
    expect(parseVideoId(input)).toBe(expected);
  });
});

describe("parseVideoId rejects non-video input", () => {
  const rejected: string[] = [
    "",
    "   ",
    "dQw4w9WgXc",
    "dQw4w9WgXcQQ",
    "dQw4w9WgX!Q",
    "not a url at all",
    "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
    "https://www.youtube.com/watch?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
    "https://www.youtube.com/embed/videoseries?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
    "https://music.youtube.com/playlist?list=OLAK5uy_abc",
    `https://www.youtube.com/channel/${CHANNEL}`,
    "https://www.youtube.com/@veritasium",
    "https://www.youtube.com/c/veritasium",
    "https://www.youtube.com/user/1veritasium",
    "https://www.youtube.com/results?search_query=rick+astley",
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/history",
    `https://www.youtube.com/watch?v=${ID}x`,
    "https://www.youtube.com/watch?v=",
    `https://www.youtube.com/shorts/${ID}extra`,
    `https://www.youtube.com/shorts/${ID}/more`,
    `https://example.com/watch?v=${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}/extra`,
    "https://youtu.be/",
    `ftp://www.youtube.com/watch?v=${ID}`,
    `javascript:alert('${ID}')`,
    `https://www.youtube.com/watch?v=${ID} trailing words`,
    `youtube/watch?v=${ID}`,
  ];

  it.each(rejected)("%j", (input) => {
    expect(parseVideoId(input)).toBeNull();
  });
});

describe("id helpers", () => {
  it("validates video and channel ids", () => {
    expect(isVideoId(ID)).toBe(true);
    expect(isVideoId(`${ID} `)).toBe(false);
    expect(isChannelId(CHANNEL)).toBe(true);
    expect(isChannelId(CHANNEL.slice(1))).toBe(false);
  });

  it("builds the canonical watch url", () => {
    expect(canonicalWatchUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(parseVideoId(canonicalWatchUrl(DASH_ID))).toBe(DASH_ID);
  });

  it("refuses to build a url for an invalid id", () => {
    expect(() => canonicalWatchUrl("nope")).toThrow(RangeError);
    expect(() => canonicalWatchUrl(`https://youtu.be/${ID}`)).toThrow(RangeError);
  });
});

describe("parseChannelRef", () => {
  const accepted: [string, ReturnType<typeof parseChannelRef>][] = [
    [CHANNEL, { kind: "id", value: CHANNEL }],
    [`  ${CHANNEL}\n`, { kind: "id", value: CHANNEL }],
    [`https://www.youtube.com/channel/${CHANNEL}`, { kind: "id", value: CHANNEL }],
    [`youtube.com/channel/${CHANNEL}/videos`, { kind: "id", value: CHANNEL }],
    [`https://m.youtube.com/channel/${CHANNEL}?view_as=subscriber`, { kind: "id", value: CHANNEL }],
    ["@veritasium", { kind: "handle", value: "veritasium" }],
    ["@3blue1brown", { kind: "handle", value: "3blue1brown" }],
    ["@some.name-with_bits", { kind: "handle", value: "some.name-with_bits" }],
    ["https://www.youtube.com/@veritasium", { kind: "handle", value: "veritasium" }],
    ["youtube.com/@veritasium/videos", { kind: "handle", value: "veritasium" }],
    ["https://www.youtube.com/@veritasium?si=abc", { kind: "handle", value: "veritasium" }],
    ["https://www.youtube.com/%40veritasium", { kind: "handle", value: "veritasium" }],
    [
      "https://www.youtube.com/@caf%C3%A9",
      { kind: "handle", value: `caf${String.fromCharCode(0xe9)}` },
    ],
    ["https://www.youtube.com/c/Veritasium", { kind: "url-custom", value: "Veritasium" }],
    ["https://www.youtube.com/c/Veritasium/featured", { kind: "url-custom", value: "Veritasium" }],
    ["https://www.youtube.com/user/1veritasium", { kind: "user", value: "1veritasium" }],
    [
      "http://youtube.com/user/1veritasium/videos?flow=grid",
      { kind: "user", value: "1veritasium" },
    ],
  ];

  it.each(accepted)("%s", (input, expected) => {
    expect(parseChannelRef(input)).toEqual(expected);
  });

  const rejected: string[] = [
    "",
    "veritasium",
    "@a",
    "@has space",
    "@this-handle-is-far-too-long-to-be-valid",
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
    "https://www.youtube.com/channel/UCshort",
    "https://www.youtube.com/channel/",
    "https://www.youtube.com/c/",
    "https://www.youtube.com/@veritasium/videos/extra",
    `https://example.com/channel/${CHANNEL}`,
    "https://www.youtube.com/",
    ID,
  ];

  it.each(rejected)("rejects %j", (input) => {
    expect(parseChannelRef(input)).toBeNull();
  });
});
