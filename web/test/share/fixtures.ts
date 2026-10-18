import type { SharePublicData } from "@cellar/shared";
import { SHARE_DATA_ID } from "../../src/share/mount.ts";

export const TOKEN = "AbCdEfGhIjKlMnOpQrSt_-";

/** A full payload as public/share.ts injects it. */
export function payload(overrides: Partial<SharePublicData> = {}): SharePublicData {
  const base = `/s/${TOKEN}`;
  return {
    token: TOKEN,
    video: {
      id: "dQw4w9WgXcQ",
      title: "Cellar tour",
      channel_title: "Wine Channel",
      upload_date: Date.UTC(2026, 1, 3),
      duration_s: 3725,
      description: "Line one\nLine two",
      views: 12345,
      likes: 1,
    },
    media: {
      kind: "video",
      mime: "video/webm",
      size_bytes: 5 * 1024 * 1024,
      height: 1080,
      has_audio_only: true,
    },
    captions: [
      { lang: "de", label: "German" },
      { lang: "en-US", label: "American English" },
    ],
    thumbnail: true,
    downloads: {
      video: `${base}/video`,
      audio: `${base}/audio`,
      captions: { de: `${base}/captions/de`, "en-US": `${base}/captions/en-US` },
      metadata: `${base}/metadata.json`,
    },
    ...overrides,
  };
}

export function injectData(json: string, type = "application/json"): void {
  const script = document.createElement("script");
  script.id = SHARE_DATA_ID;
  script.type = type;
  script.textContent = json;
  document.head.append(script);
}
