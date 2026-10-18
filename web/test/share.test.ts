import { beforeEach, describe, expect, it } from "vitest";
import html from "../share.html?raw";
import { isShareHost, shareAwareUrl } from "../src/build/shareUrls.ts";
import {
  NOT_FOUND_MESSAGE,
  NOT_FOUND_TITLE,
  SHARE_DATA_ID,
  mountShare,
  readShareData,
  renderNotFound,
  shareTokenFromPath,
} from "../src/share/mount.ts";

const TOKEN = "AbCdEfGhIjKlMnOpQrSt_-";

function injectData(json: string, type = "application/json"): void {
  const script = document.createElement("script");
  script.id = SHARE_DATA_ID;
  script.type = type;
  script.textContent = json;
  document.head.append(script);
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = '<div id="app"></div>';
  document.title = "Cellar";
});

describe("shareTokenFromPath", () => {
  it("extracts the token from /s/<token>", () => {
    expect(shareTokenFromPath(`/s/${TOKEN}`)).toBe(TOKEN);
    expect(shareTokenFromPath(`/s/${TOKEN}/`)).toBe(TOKEN);
  });

  it("rejects anything that is not exactly one token segment", () => {
    expect(shareTokenFromPath("/s/")).toBeNull();
    expect(shareTokenFromPath("/")).toBeNull();
    expect(shareTokenFromPath(`/s/${TOKEN}/video`)).toBeNull();
    expect(shareTokenFromPath("/s/has space")).toBeNull();
    expect(shareTokenFromPath("/x/abc")).toBeNull();
  });
});

describe("readShareData", () => {
  it("is null when the server injected nothing", () => {
    expect(readShareData(document)).toBeNull();
  });

  it("parses an injected JSON object", () => {
    injectData('{"title":"A video"}');
    expect(readShareData(document)).toEqual({ title: "A video" });
  });

  it("ignores malformed JSON, non-objects and the wrong script type", () => {
    injectData("{not json");
    expect(readShareData(document)).toBeNull();
    document.head.innerHTML = "";
    injectData("[1,2]");
    expect(readShareData(document)).toBeNull();
    document.head.innerHTML = "";
    injectData("null");
    expect(readShareData(document)).toBeNull();
    document.head.innerHTML = "";
    injectData('{"title":"x"}', "text/plain");
    expect(readShareData(document)).toBeNull();
  });
});

describe("the 404 view", () => {
  it("renders exactly the title and one sentence", () => {
    const view = mountShare(document, `/s/${TOKEN}`);

    expect(view).toBe("not-found");
    const main = document.querySelector("#app > main");
    expect(main?.querySelector("h1")?.textContent).toBe(NOT_FOUND_TITLE);
    expect(main?.querySelector("p")?.textContent).toBe(NOT_FOUND_MESSAGE);
    expect(main?.children).toHaveLength(2);
    expect(document.title).toBe("Not found");
  });

  it("uses the exact uniform copy", () => {
    expect(NOT_FOUND_TITLE).toBe("Not found");
    expect(NOT_FOUND_MESSAGE).toBe("This link does not exist, has expired, or was revoked.");
  });

  it("offers no links, buttons or hints", () => {
    mountShare(document, "/s/nope");
    expect(document.querySelectorAll("a, button, nav, form")).toHaveLength(0);
  });

  it("is identical for a bad path, a missing payload and a malformed payload", () => {
    mountShare(document, "/s/");
    const badPath = document.body.innerHTML;
    mountShare(document, `/s/${TOKEN}`);
    const missing = document.body.innerHTML;
    injectData("{broken");
    mountShare(document, `/s/${TOKEN}`);
    const malformed = document.body.innerHTML;

    expect(missing).toBe(badPath);
    expect(malformed).toBe(badPath);
  });

  it("ignores injected data when the path carries no token", () => {
    injectData('{"title":"A video"}');
    expect(mountShare(document, "/s/")).toBe("not-found");
  });

  it("falls back to the body when there is no #app root", () => {
    document.body.innerHTML = "";
    renderNotFound(document.body, document);
    expect(document.body.querySelector("h1")?.textContent).toBe(NOT_FOUND_TITLE);
  });
});

describe("the player placeholder", () => {
  it("renders when the server injected share data", () => {
    injectData('{"title":"Cellar tour"}');

    expect(mountShare(document, `/s/${TOKEN}`)).toBe("player");
    expect(document.querySelector("h1")?.textContent).toBe("Cellar tour");
    expect(document.title).toBe("Cellar tour");
  });

  it("never interprets the payload as HTML", () => {
    injectData(JSON.stringify({ title: "<img src=x onerror=alert(1)>" }));
    mountShare(document, `/s/${TOKEN}`);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("uses a generic title when the payload has none", () => {
    injectData("{}");
    mountShare(document, `/s/${TOKEN}`);
    expect(document.querySelector("h1")?.textContent).toBe("Shared video");
  });
});

describe("share.html", () => {
  it("keeps the noindex robots meta", () => {
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it("loads only the share entry, and nothing from outside the bundle", () => {
    expect(html).toContain('src="/src/share.ts"');
    expect(html).not.toContain("main.ts");
    // The favicon is referenced relatively so Vite bundles it under /s/assets/.
    expect(html).not.toMatch(/href="\/favicon/);
  });
});

describe("share asset URLs", () => {
  it("treats share.html and share-* files as share hosts", () => {
    expect(isShareHost("share.html")).toBe(true);
    expect(isShareHost("assets/share-AbC123.js")).toBe(true);
    expect(isShareHost("assets\\share-AbC123.css")).toBe(true);
    expect(isShareHost("index.html")).toBe(false);
    expect(isShareHost("assets/index-AbC123.js")).toBe(false);
    expect(isShareHost("assets/SharesPage-AbC123.js")).toBe(false);
  });

  it("prefixes /s/ only for share hosts", () => {
    const share = { hostId: "share.html", hostType: "html" };
    const admin = { hostId: "index.html", hostType: "html" };
    expect(shareAwareUrl("assets/share-x.js", share)).toBe("/s/assets/share-x.js");
    expect(shareAwareUrl("assets/index-x.js", admin)).toBeUndefined();
  });
});
