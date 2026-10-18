import { describe, expect, it } from "vitest";
import {
  isAcceptedFile,
  kindLabel,
  readTakeoutJobEvent,
  skipReasonLabel,
  toImportEntry,
  uploadTakeout,
} from "../../src/api/takeout.ts";
import { createApiClient } from "../../src/api/client.ts";
import { counts, EMOJI, FakeXhr, importActivity, preview } from "./fixtures.ts";

describe("takeout api helpers", () => {
  it("accepts archives and loose export files by name", () => {
    for (const name of ["a.tgz", "a.TAR.GZ", "a.zip", "watch-history.json", "x.csv"]) {
      expect(isAcceptedFile(name), name).toBe(true);
    }
    for (const name of ["a.tar", "watch-history.html", "notes.txt"]) {
      expect(isAcceptedFile(name), name).toBe(false);
    }
  });

  it("labels kinds and skip reasons", () => {
    expect(kindLabel("history")).toBe("Watch history");
    expect(kindLabel("watch_later")).toBe("Watch later");
    expect(kindLabel("liked")).toBe("Liked videos");
    expect(kindLabel("subscription")).toBe("Subscriptions");
    expect(kindLabel(`playlist:${EMOJI}`)).toBe(`Playlist "${EMOJI}" (counted, not imported)`);
    expect(kindLabel("other")).toBe("other");
    expect(skipReasonLabel("unreadable: no header")).toBe("Unreadable: no header");
    expect(skipReasonLabel("history-is-html")).toBe("History exported as HTML");
    expect(skipReasonLabel("something-new")).toBe("something-new");
  });

  it("reads job events for one job only", () => {
    expect(readTakeoutJobEvent("job.progress", { id: 7, pct: 140, message: "m" }, 7)).toEqual({
      type: "progress",
      pct: 100,
      message: "m",
    });
    expect(readTakeoutJobEvent("job.done", { id: 7 }, 7)).toEqual({
      type: "done",
      pct: null,
      message: null,
    });
    expect(readTakeoutJobEvent("job.progress", { id: 8, pct: 1 }, 7)).toBeNull();
    expect(readTakeoutJobEvent("job.weird", { id: 7 }, 7)).toBeNull();
    expect(readTakeoutJobEvent("activity", { id: 7 }, 7)).toBeNull();
    expect(readTakeoutJobEvent("job.done", "nope", 7)).toBeNull();
  });

  it("maps activity rows to import entries, tolerating foreign data", () => {
    expect(toImportEntry(importActivity(4) as never).counts).toEqual(counts());
    expect(toImportEntry(importActivity(5, { data: null }) as never).counts).toBeNull();
  });

  it("uploads to the client's base url and resolves the preview", async () => {
    const api = createApiClient({ baseUrl: "/base" });
    const xhr = new FakeXhr();
    const handle = uploadTakeout(
      api,
      { files: [new File(["a"], "a.zip")], accountId: 3 },
      () => xhr,
    );
    expect(xhr.url).toBe("/base/api/takeout?account_id=3");
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers.Accept).toBe("application/json");
    xhr.progress(1, 0);
    xhr.respond(202, preview());
    await expect(handle.promise).resolves.toEqual(preview());
  });

  it("rejects with the server's code and details", async () => {
    const api = createApiClient();
    const xhr = new FakeXhr();
    const handle = uploadTakeout(api, { files: [], accountId: 1 }, () => xhr);
    xhr.respond(400, { error: "bad", code: "no_files", details: { a: 1 } });
    await expect(handle.promise).rejects.toMatchObject({
      problem: "no_files",
      message: "bad",
      status: 400,
      details: { a: 1 },
    });
    const second = new FakeXhr();
    const other = uploadTakeout(api, { files: [], accountId: 1 }, () => second);
    second.respond(404, { error: "Account 1 does not exist." });
    await expect(other.promise).rejects.toMatchObject({ problem: "http_404" });
    const third = new FakeXhr();
    const raw = uploadTakeout(api, { files: [], accountId: 1 }, () => third);
    third.respond(502, "", "");
    await expect(raw.promise).rejects.toMatchObject({ message: "The server is unreachable." });
  });

  it("rejects a success body that is not JSON", async () => {
    const xhr = new FakeXhr();
    const handle = uploadTakeout(createApiClient(), { files: [], accountId: 1 }, () => xhr);
    xhr.respond(202, "<html>");
    await expect(handle.promise).rejects.toMatchObject({ problem: "invalid_response" });
  });
});
