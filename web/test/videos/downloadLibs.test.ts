import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILENAME_TEMPLATE } from "@cellar/shared";
import {
  BULK_DOWNLOAD_ACTION,
  BULK_DOWNLOAD_FRAME,
  buildZipForm,
  effectiveTemplate,
  ensureDownloadFrame,
  firstSource,
  previewNames,
  rowFilenameFields,
  submitZipDownload,
  templateProblem,
} from "../../src/lib/bulkDownload.ts";
import {
  downloadToFolder,
  existingNames,
  pickDirectory,
  planVideoFiles,
  supportsDirectoryPicker,
  type FolderItem,
  type FsDirectoryHandle,
  type FsWritable,
} from "../../src/lib/folderDownload.ts";
import { apiError, fakeServer, json } from "../helpers/fakeServer.ts";
import { ID, ID2, mediaRow, UPLOADED, videoDetail, videoRow } from "./fixtures.ts";

// happy-dom refuses to load an iframe (about:blank included) unless told it may.
const happyDom = (window as unknown as { happyDOM: { settings: Record<string, unknown> } })
  .happyDOM;
happyDom.settings["enableIframePageLoading"] = true;
happyDom.settings["disableIframePageLoading"] = false;

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).showDirectoryPicker;
  document.body.replaceChildren();
});

describe("filename templates and the preview", () => {
  it("validates templates", () => {
    expect(templateProblem("{title}.{ext}")).toBeNull();
    expect(templateProblem("   ")).toContain("Enter a template");
    expect(templateProblem("x".repeat(501))).toContain("500 characters");
    expect(effectiveTemplate("  ")).toBe(DEFAULT_FILENAME_TEMPLATE);
    expect(effectiveTemplate(" {id} ")).toBe("{id}");
  });

  it("names files the way the server does", () => {
    const row = videoRow({
      sources: [
        { account_id: 1, source: "liked", first_seen_at: 20 },
        { account_id: null, source: "history", first_seen_at: 10 },
      ],
    });
    expect(firstSource(row)).toBe("history");
    expect(firstSource(videoRow({ sources: [] }))).toBeNull();
    expect(rowFilenameFields(row)).toMatchObject({
      title: "A video about things",
      channel: "Tech Channel",
      upload_date: "2024-03-05",
      id: ID,
      source: "history",
      duration: 245,
    });
    const template = "{upload_date} {channel} - {title} {resolution} {duration} [{id}].{ext}";
    expect(previewNames(template, row, "video")).toEqual([
      `2024-03-05 Tech Channel - A video about things 1080p 4m05s [${ID}].mp4`,
    ]);
    expect(previewNames("", row, "audio")).toEqual([`A video about things [${ID}].m4a`]);
    expect(previewNames("{id}", row, "captions")).toEqual([`${ID}.en.vtt`]);
    expect(previewNames("{id}", row, "all")).toEqual([
      `${ID}.mp4`,
      `${ID}.m4a`,
      `${ID}.en.vtt`,
      `${ID}.metadata.json`,
    ]);
    expect(rowFilenameFields(videoRow({ upload_date: null })).upload_date).toBeNull();
  });
});

describe("ZIP form post", () => {
  it("builds one comma-joined ids field and leaves a blank template out", () => {
    const form = buildZipForm({ ids: [ID, ID2], kind: "audio", template: "  " });
    expect(form.method.toLowerCase()).toBe("post");
    expect(form.getAttribute("action")).toBe(BULK_DOWNLOAD_ACTION);
    expect(form.target).toBe(BULK_DOWNLOAD_FRAME);
    const fields = Object.fromEntries(
      [...form.querySelectorAll("input")].map((input) => [input.name, input.value]),
    );
    expect(fields).toEqual({ ids: `${ID},${ID2}`, kind: "audio" });
    const withTemplate = buildZipForm({ ids: [ID], kind: "video", template: " {id}.{ext} " });
    expect(withTemplate.querySelector<HTMLInputElement>("input[name='template']")!.value).toBe(
      "{id}.{ext}",
    );
  });

  it("submits into a hidden iframe and cleans the form up", () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    const doc = document.implementation.createHTMLDocument("bulk");
    submitZipDownload({ ids: [ID], kind: "all", template: "{id}" }, doc);
    submitZipDownload({ ids: [ID2], kind: "video", template: "" }, doc);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(doc.querySelectorAll(`iframe[name='${BULK_DOWNLOAD_FRAME}']`)).toHaveLength(1);
    expect(doc.querySelector("form")).toBeNull();
    expect(ensureDownloadFrame(doc).hidden).toBe(true);
  });
});

// --- folder download --------------------------------------------------------

interface FakeFolder extends FsDirectoryHandle {
  files: Map<string, string>;
}

function textOf(chunks: Uint8Array[]): string {
  return new TextDecoder().decode(
    chunks.reduce((all, chunk) => {
      const merged = new Uint8Array(all.length + chunk.length);
      merged.set(all);
      merged.set(chunk, all.length);
      return merged;
    }, new Uint8Array()),
  );
}

/** A directory whose files are real WritableStreams, so pipeTo streams into them. */
function fakeFolder(existing: string[] = [], options: { stream?: boolean } = {}): FakeFolder {
  const files = new Map<string, string>(existing.map((name) => [name, "old"]));
  return {
    name: "Downloads",
    files,
    async *keys() {
      yield* existing;
    },
    async getFileHandle(name) {
      return {
        async createWritable() {
          if (options.stream === false) {
            const parts: string[] = [];
            const writable: FsWritable = {
              async write(data) {
                parts.push(data instanceof Blob ? await data.text() : String(data));
              },
              async close() {
                files.set(name, parts.join(""));
              },
            };
            return writable;
          }
          const chunks: Uint8Array[] = [];
          const stream = new WritableStream<Uint8Array>({
            write(chunk) {
              chunks.push(chunk);
            },
            close() {
              files.set(name, textOf(chunks));
            },
          });
          return stream as WritableStream<Uint8Array> & FsWritable;
        },
      };
    },
  };
}

function text(body: string): Response {
  return new Response(body, { status: 200 });
}

describe("folder download support", () => {
  it("detects and picks a directory", async () => {
    expect(supportsDirectoryPicker()).toBe(false);
    expect(await pickDirectory()).toBeNull();
    const folder = fakeFolder();
    const picker = vi.fn().mockResolvedValue(folder);
    (globalThis as Record<string, unknown>).showDirectoryPicker = picker;
    expect(supportsDirectoryPicker()).toBe(true);
    expect(await pickDirectory()).toBe(folder);
    expect(picker).toHaveBeenCalledWith({ mode: "readwrite", id: "cellar-bulk" });
    picker.mockRejectedValueOnce(new DOMException("dismissed", "AbortError"));
    expect(await pickDirectory()).toBeNull();
  });

  it("lists what the folder already holds, tolerating a folder that refuses", async () => {
    expect([...(await existingNames(fakeFolder(["A.mp4"])))]).toEqual(["a.mp4"]);
    expect((await existingNames({ ...fakeFolder(), keys: undefined })).size).toBe(0);
    const refusing = {
      ...fakeFolder(),
      async *keys(): AsyncGenerator<string> {
        yield* [];
        throw new Error("denied");
      },
    };
    expect((await existingNames(refusing)).size).toBe(0);
  });
});

describe("planVideoFiles", () => {
  it("plans each kind with the server's names", () => {
    const detail = videoDetail();
    const stem = `A video about things [${ID}]`;
    expect(planVideoFiles(detail, "video", "").map((f) => [f.name, f.url])).toEqual([
      [`${stem}.mkv`, `/api/videos/${ID}/media/11?download=1`],
    ]);
    expect(planVideoFiles(detail, "audio", "").map((f) => f.name)).toEqual([`${stem}.m4a`]);
    expect(planVideoFiles(detail, "captions", "").map((f) => f.name)).toEqual([
      `${stem}.en.vtt`,
      `${stem}.de.vtt`,
    ]);
    const all = planVideoFiles(detail, "all", "{id} {resolution}.{ext}");
    expect(all.map((f) => f.name)).toEqual([
      `${ID} 1080p.mkv`,
      `${ID}.m4a`,
      `${ID} 1080p.en.vtt`,
      `${ID} 1080p.de.vtt`,
      `${ID} 1080p.metadata.json`,
    ]);
    expect(all[4]).toMatchObject({ url: `/api/videos/${ID}/metadata.json`, size: null });
  });

  it("falls back to a stem without media and normalises odd captions", () => {
    const detail = videoDetail({
      media: [
        mediaRow({ id: 30, kind: "captions", lang: null, rel_path: "c/x.vtt" }),
        mediaRow({ id: 31, kind: "captions", lang: null, rel_path: "c/y.vtt" }),
        mediaRow({ id: 32, kind: "info", rel_path: "info", size_bytes: 77 }),
        mediaRow({ id: 33, kind: "video", is_current: false }),
      ],
    });
    const names = planVideoFiles(detail, "all", "{title}");
    expect(names.map((f) => f.name)).toEqual([
      "A video about things.und.vtt",
      "A video about things.metadata.json",
    ]);
    expect(names[1]!.size).toBe(77);
    expect(planVideoFiles(detail, "video", "")).toEqual([]);
  });
});

describe("downloadToFolder", () => {
  function detailRoute(server: ReturnType<typeof fakeServer>) {
    server.on("GET", `/api/videos/${ID}`, () => json(videoDetail()));
    server.on("GET", `/api/videos/${ID2}`, () =>
      json(
        videoDetail({
          id: ID2,
          media: [mediaRow({ id: 21, rel_path: "x/video.mkv" })],
          upload_date: UPLOADED,
        }),
      ),
    );
    return server;
  }

  it("streams every file into the folder with unique names", async () => {
    const server = detailRoute(fakeServer())
      .on("GET", `/api/videos/${ID}/media/11`, () => text("video-bytes"))
      .on("GET", `/api/videos/${ID2}/media/21`, () => text("second"));
    const folder = fakeFolder(["A Video About Things.mkv"]);
    const snapshots: FolderItem[][] = [];
    const result = await downloadToFolder({
      api: server.api,
      ids: [ID, ID2],
      kind: "video",
      template: "{title}.{ext}",
      directory: folder,
      onProgress: (items) => snapshots.push(items),
    });
    expect(result).toMatchObject({ written: 2, failed: 0, cancelled: false });
    expect(result.items.map((item) => [item.name, item.state])).toEqual([
      ["A video about things (2).mkv", "done"],
      ["A video about things (3).mkv", "done"],
    ]);
    expect(folder.files.get("A Video About Things.mkv")).toBe("old");
    expect(folder.files.get("A video about things (2).mkv")).toBe("video-bytes");
    expect(folder.files.get("A video about things (3).mkv")).toBe("second");
    expect(result.items[0]!.bytes).toBe(11);
    expect(snapshots.length).toBeGreaterThan(2);
    expect(server.callsTo("GET", `/api/videos/${ID}/media/11`)[0]!.query.get("download")).toBe("1");
  });

  it("writes a blob when the file handle is not a stream", async () => {
    const server = detailRoute(fakeFolderServer());
    const folder = fakeFolder([], { stream: false });
    const result = await downloadToFolder({
      api: server.api,
      ids: [ID2],
      kind: "video",
      template: "",
      directory: folder,
    });
    expect(result.written).toBe(1);
    expect(folder.files.get(`A video about things [${ID2}].mkv`)).toBe("second");
  });

  function fakeFolderServer() {
    return fakeServer().on("GET", `/api/videos/${ID2}/media/21`, () => text("second"));
  }

  it("records failures and moves on, and skips a video without files", async () => {
    const server = fakeServer()
      .on("GET", `/api/videos/${ID}`, () => apiError(404, "gone", "not_found"))
      .on("GET", `/api/videos/${ID2}`, () => json(videoDetail({ id: ID2 })))
      .on("GET", `/api/videos/${ID2}/media/12`, () => apiError(500, "disk"));
    const result = await downloadToFolder({
      api: server.api,
      ids: [ID, ID2, "zzzzzzzzzzz"],
      kind: "audio",
      template: "",
      directory: fakeFolder(),
    });
    expect(result.failed).toBe(3);
    expect(result.items.map((item) => [item.name, item.state])).toEqual([
      [ID, "failed"],
      [`A video about things [${ID2}].m4a`, "failed"],
      ["zzzzzzzzzzz", "failed"],
    ]);
    expect(result.items[0]!.error).toBe("gone");
    const none = await downloadToFolder({
      api: fakeServer().on("GET", `/api/videos/${ID}`, () => json(videoDetail({ media: [] }))).api,
      ids: [ID],
      kind: "video",
      template: "",
      directory: fakeFolder(),
    });
    expect(none.items[0]!.state).toBe("skipped");
  });

  it("stops when canceled", async () => {
    const controller = new AbortController();
    const server = detailRoute(fakeServer()).on("GET", `/api/videos/${ID}/media/11`, () => {
      setTimeout(() => controller.abort(), 0);
      return new Promise<Response>(() => undefined);
    });
    const result = await downloadToFolder({
      api: server.api,
      ids: [ID, ID2],
      kind: "video",
      template: "",
      directory: fakeFolder(),
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.written).toBe(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ state: "failed", error: "Canceled." });
    expect(server.callsTo("GET", `/api/videos/${ID2}`)).toHaveLength(0);
  });

  it("stops quietly when canceled while reading a video", async () => {
    const controller = new AbortController();
    const server = fakeServer().on("GET", `/api/videos/${ID}`, () => {
      setTimeout(() => controller.abort(), 0);
      return new Promise<Response>(() => undefined);
    });
    const result = await downloadToFolder({
      api: server.api,
      ids: [ID],
      kind: "video",
      template: "",
      directory: fakeFolder(),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ cancelled: true, items: [] });
  });

  it("stops between files when canceled after one finishes", async () => {
    const controller = new AbortController();
    const server = fakeServer()
      .on("GET", `/api/videos/${ID}`, () => json(videoDetail()))
      .on("GET", `/api/videos/${ID}/media/13`, () => text("WEBVTT en"))
      .on("GET", `/api/videos/${ID}/media/14`, () => text("WEBVTT de"));
    const result = await downloadToFolder({
      api: server.api,
      ids: [ID],
      kind: "captions",
      template: "",
      directory: fakeFolder(),
      signal: controller.signal,
      onProgress: (items) => {
        if (items.some((item) => item.state === "done")) controller.abort();
      },
    });
    expect(result).toMatchObject({ written: 1, cancelled: true });
    expect(server.callsTo("GET", `/api/videos/${ID}/media/14`)).toHaveLength(0);
  });
});

describe("planVideoFiles edge cases", () => {
  it("handles a file without an extension and a video without an upload date", () => {
    const detail = videoDetail({
      upload_date: null,
      media: [mediaRow({ rel_path: "x/video" })],
    });
    expect(planVideoFiles(detail, "video", "{upload_date}{title}").map((f) => f.name)).toEqual([
      "A video about things",
    ]);
  });
});
