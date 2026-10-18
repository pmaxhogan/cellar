import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseShareData, shareUrls } from "../../src/share/data.ts";
import { formatBytes, formatCount, formatDate, formatDuration } from "../../src/share/format.ts";
import { mountShare, NOT_FOUND_TITLE } from "../../src/share/mount.ts";
import {
  defaultCaption,
  handleShortcut,
  renderPlayer,
  SPEEDS,
  speedLabel,
} from "../../src/share/player.ts";
import { injectData, payload, TOKEN } from "./fixtures.ts";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = '<div id="app"></div>';
  document.title = "Cellar";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mountWith(data: unknown): ReturnType<typeof mountShare> {
  injectData(JSON.stringify(data));
  return mountShare(document, `/s/${TOKEN}`);
}

function video(): HTMLVideoElement {
  const node = document.querySelector("video");
  if (node === null) throw new Error("no video");
  return node;
}

describe("the share player", () => {
  it("renders the title, facts, counts and player from the injected data", () => {
    expect(mountWith(payload())).toBe("player");
    expect(document.title).toBe("Cellar tour");
    expect(document.querySelector("h1")?.textContent).toBe("Cellar tour");
    const facts = [...document.querySelectorAll(".share-facts .share-fact")].map(
      (n) => n.textContent,
    );
    expect(facts).toEqual(["Wine Channel", "Feb 3, 2026", "1:02:05"]);
    const counts = [...document.querySelectorAll(".share-counts .share-fact")].map(
      (n) => n.textContent,
    );
    expect(counts).toEqual(["12,345 views", "1 like"]);

    const player = video();
    expect(player.controls).toBe(true);
    expect(player.getAttribute("poster")).toBe(`/s/${TOKEN}/thumbnail`);
    const source = player.querySelector("source");
    expect(source?.getAttribute("src")).toBe(`/s/${TOKEN}/video`);
    expect(source?.getAttribute("type")).toBe("video/webm");
    expect(document.querySelector("audio")).toBeNull();
  });

  it("adds a caption track per language with English as the default", () => {
    mountWith(payload());
    const tracks = [...video().querySelectorAll("track")];
    expect(tracks.map((t) => [t.srclang, t.label, t.getAttribute("src"), t.default])).toEqual([
      ["de", "German", `/s/${TOKEN}/captions/de`, false],
      ["en-US", "American English", `/s/${TOKEN}/captions/en-US`, true],
    ]);
    expect(tracks.every((t) => t.kind === "captions")).toBe(true);
  });

  it("defaults to the first track when none is English", () => {
    expect(defaultCaption([])).toBeNull();
    expect(
      defaultCaption([
        { lang: "fr", label: "French" },
        { lang: "de", label: "German" },
      ])?.lang,
    ).toBe("fr");
    expect(
      defaultCaption([
        { lang: "eno", label: "x" },
        { lang: "en_GB", label: "y" },
      ])?.lang,
    ).toBe("en_GB");
  });

  it("offers download buttons for video, audio, every caption and metadata", () => {
    mountWith(payload());
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".share-download")];
    expect(links.map((a) => [a.getAttribute("href"), a.textContent])).toEqual([
      [`/s/${TOKEN}/video?download=1`, "Video1080p, 5.0 MB"],
      [`/s/${TOKEN}/audio?download=1`, "Audio"],
      [`/s/${TOKEN}/captions/de?download=1`, "CaptionsGerman"],
      [`/s/${TOKEN}/captions/en-US?download=1`, "CaptionsAmerican English"],
      [`/s/${TOKEN}/metadata.json?download=1`, "MetadataJSON"],
    ]);
    expect(links.every((a) => a.hasAttribute("download"))).toBe(true);
  });

  it("builds every URL itself and never follows one from the payload", () => {
    const data = payload();
    data.downloads.video = "https://evil.example/x";
    data.downloads.captions["de"] = "https://evil.example/y";
    data.downloads.metadata = "/api/settings";
    mountWith(data);
    const hrefs = [...document.querySelectorAll("a, source, track")].map(
      (n) => n.getAttribute("href") ?? n.getAttribute("src") ?? "",
    );
    for (const href of hrefs) {
      expect(href.startsWith(`/s/${TOKEN}/`) || href === "/s/privacy" || href === "/s/tos").toBe(
        true,
      );
    }
  });

  it("collapses the description and keeps it as text", () => {
    mountWith(payload({ video: { ...payload().video, description: "<b>bold</b>\nnext" } }));
    const details = document.querySelector("details.share-description");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Description");
    expect(details?.querySelector("p")?.textContent).toBe("<b>bold</b>\nnext");
    expect(document.querySelector("b")).toBeNull();
  });

  it("shows a small footer linking to the legal pages", () => {
    mountWith(payload());
    const footer = document.querySelector("footer.share-footer");
    expect(footer?.textContent).toContain("Shared from cellar");
    expect([...(footer?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual([
      "/s/privacy",
      "/s/tos",
    ]);
  });

  it("plays audio when only audio is stored", () => {
    const data = payload({
      media: {
        kind: "audio",
        mime: "audio/mp4",
        size_bytes: 2048,
        height: null,
        has_audio_only: true,
      },
      thumbnail: false,
      captions: [],
      downloads: { audio: `/s/${TOKEN}/audio`, captions: {}, metadata: "x" },
    });
    mountWith(data);
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("audio")?.getAttribute("src")).toBe(`/s/${TOKEN}/audio`);
    const labels = [...document.querySelectorAll(".share-download")].map((a) => a.textContent);
    expect(labels).toEqual(["Audio2.0 KB", "MetadataJSON"]);
  });

  it("explains a missing file and skips the speed menu", () => {
    mountWith(
      payload({
        media: null,
        captions: [],
        thumbnail: false,
        downloads: { captions: {}, metadata: "x" },
        video: {
          id: "x",
          title: null,
          channel_title: null,
          upload_date: null,
          duration_s: null,
          description: null,
          views: null,
          likes: null,
        },
      }),
    );
    expect(document.querySelector(".share-unavailable")?.textContent).toContain("not available");
    expect(document.querySelector("select")).toBeNull();
    expect(document.querySelector(".share-facts")).toBeNull();
    expect(document.querySelector(".share-counts")).toBeNull();
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("Shared video");
    expect(document.title).toBe("Shared video");
  });

  it("never interprets the payload as HTML", () => {
    const evil = "<img src=x onerror=alert(1)>";
    mountWith(payload({ video: { ...payload().video, title: evil, channel_title: evil } }));
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe(evil);
  });
});

describe("the speed menu", () => {
  it("lists 0.5x to 3x with Normal selected and sets the playback rate", () => {
    mountWith(payload());
    const select = document.querySelector<HTMLSelectElement>("[data-test='speed']");
    if (select === null) throw new Error("no speed menu");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "0.5x",
      "0.75x",
      "Normal",
      "1.25x",
      "1.5x",
      "1.75x",
      "2x",
      "2.5x",
      "3x",
    ]);
    expect(select.value).toBe("1");
    expect(SPEEDS[0]).toBe(0.5);
    expect(SPEEDS[SPEEDS.length - 1]).toBe(3);

    select.value = "2.5";
    select.dispatchEvent(new Event("change"));
    expect(video().playbackRate).toBe(2.5);

    video().playbackRate = 0.75;
    video().dispatchEvent(new Event("ratechange"));
    expect(select.value).toBe("0.75");
  });

  it("labels speeds", () => {
    expect(speedLabel(1)).toBe("Normal");
    expect(speedLabel(1.5)).toBe("1.5x");
  });
});

describe("keyboard shortcuts", () => {
  function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it("toggles play with space and k, seeks with j/l and arrows, sets volume", () => {
    mountWith(payload());
    const media = video();
    const play = vi.spyOn(media, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(media, "pause").mockImplementation(() => undefined);
    let paused = true;
    vi.spyOn(media, "paused", "get").mockImplementation(() => paused);
    vi.spyOn(media, "duration", "get").mockReturnValue(100);

    expect(press(" ").defaultPrevented).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    paused = false;
    press("k");
    expect(pause).toHaveBeenCalledTimes(1);

    media.currentTime = 50;
    press("l");
    expect(media.currentTime).toBe(60);
    press("j");
    press("j");
    expect(media.currentTime).toBe(40);
    press("ArrowRight");
    expect(media.currentTime).toBe(45);
    press("ArrowLeft");
    expect(media.currentTime).toBe(40);
    media.currentTime = 2;
    press("J");
    expect(media.currentTime).toBe(0);
    media.currentTime = 98;
    press("L");
    expect(media.currentTime).toBe(100);

    media.volume = 0.5;
    press("ArrowUp");
    expect(media.volume).toBe(0.6);
    press("ArrowDown");
    press("ArrowDown");
    expect(media.volume).toBe(0.4);
    media.volume = 1;
    press("ArrowUp");
    expect(media.volume).toBe(1);
    media.volume = 0;
    press("ArrowDown");
    expect(media.volume).toBe(0);
  });

  it("leaves modified keys, other keys and focused controls alone", () => {
    mountWith(payload());
    const media = video();
    const play = vi.spyOn(media, "play").mockResolvedValue(undefined);
    expect(press(" ", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("x").defaultPrevented).toBe(false);
    const select = document.querySelector("select")!;
    expect(press(" ", {}, select).defaultPrevented).toBe(false);
    expect(press(" ", {}, document.querySelector("a")!).defaultPrevented).toBe(false);
    // The focused player handles its own keys.
    expect(press(" ", {}, media).defaultPrevented).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it("swallows a rejected play()", async () => {
    mountWith(payload());
    const media = video();
    vi.spyOn(media, "paused", "get").mockReturnValue(true);
    vi.spyOn(media, "play").mockRejectedValue(new Error("blocked"));
    expect(handleShortcut(new KeyboardEvent("keydown", { key: "k" }), media)).toBe(true);
    await Promise.resolve();
  });

  it("is not wired without a media element", () => {
    const root = document.getElementById("app")!;
    const media = renderPlayer(root, document, {
      ...payload(),
      media: null,
    });
    expect(media).toBeNull();
  });
});

describe("parseShareData", () => {
  it("accepts the contract and a token-matching payload only", () => {
    expect(parseShareData(payload(), TOKEN)).toEqual(payload());
    expect(parseShareData(payload(), "x".repeat(22))).toBeNull();
    expect(parseShareData({ ...payload(), token: "short" }, "short")).toBeNull();
    expect(parseShareData(null, TOKEN)).toBeNull();
  });

  it("rejects every malformed part", () => {
    const good = payload();
    const bad: unknown[] = [
      { ...good, video: null },
      { ...good, video: { ...good.video, id: 1 } },
      { ...good, video: { ...good.video, views: "1" } },
      { ...good, video: { ...good.video, title: 3 } },
      { ...good, media: "video" },
      { ...good, media: { ...good.media, kind: "info" } },
      { ...good, media: { ...good.media, size_bytes: "1" } },
      { ...good, captions: {} },
      { ...good, captions: [1] },
      { ...good, captions: [{ lang: "e n", label: "x" }] },
      { ...good, captions: [{ lang: "en" }] },
      { ...good, thumbnail: "yes" },
      { ...good, downloads: null },
      { ...good, downloads: { ...good.downloads, captions: null } },
      { ...good, downloads: { ...good.downloads, captions: { en: 1 } } },
      { ...good, downloads: { ...good.downloads, video: 1 } },
      { ...good, downloads: { ...good.downloads, audio: 1 } },
      { ...good, downloads: { ...good.downloads, metadata: null } },
    ];
    for (const value of bad) {
      expect(parseShareData(value, TOKEN), JSON.stringify(value).slice(0, 80)).toBeNull();
    }
    mountWith(bad[0]);
    expect(document.querySelector("h1")?.textContent).toBe(NOT_FOUND_TITLE);
  });

  it("drops absent optional downloads", () => {
    const { video: _video, audio: _audio, ...rest } = payload().downloads;
    const parsed = parseShareData({ ...payload(), downloads: rest }, TOKEN);
    expect(parsed?.downloads).toEqual(rest);
  });

  it("builds same-origin URLs", () => {
    const urls = shareUrls(TOKEN);
    expect(urls.captions("pt BR")).toBe(`/s/${TOKEN}/captions/pt%20BR`);
    expect(urls.download(urls.video)).toBe(`/s/${TOKEN}/video?download=1`);
  });
});

describe("formatters", () => {
  it("format durations, dates, counts and sizes", () => {
    expect(formatDuration(125)).toBe("2:05");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
    expect(formatDate(Date.UTC(2026, 0, 31, 23))).toBe("Jan 31, 2026");
    expect(formatDate(null)).toBeNull();
    expect(formatCount(0, "view", "views")).toBe("0 views");
    expect(formatCount(null, "view", "views")).toBeNull();
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatBytes(-1)).toBe("");
  });
});
