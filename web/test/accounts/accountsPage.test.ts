import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import InputNumber from "primevue/inputnumber";
import AccountsPage from "../../src/pages/AccountsPage.vue";
import AccountStatusBadge from "../../src/components/accounts/AccountStatusBadge.vue";
import {
  ACCOUNT_STATUS,
  OAUTH_ERROR_MESSAGES,
  oauthErrorMessage,
  oauthStartUrl,
  type AccountView,
} from "../../src/api/accounts.ts";
import { createApiClient } from "../../src/api/client.ts";
import { flush } from "../helpers/dom.ts";
import {
  apiError,
  captureToasts,
  fakeServer,
  noContent,
  type CapturedToast,
  type FakeServer,
} from "../helpers/adminFetch.ts";
import { mountGlobals } from "../helpers/mount.ts";

const NOW = Date.now();

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 1,
    label: "Max",
    email: "max@example.com",
    channel_id: "UC0123456789abcdefghijkl",
    status: "ok",
    has_cookies: true,
    last_api_ok_at: NOW - 5 * 60_000,
    last_cookie_ok_at: NOW - 2 * 3_600_000,
    created_at: NOW - 86_400_000,
    ...overrides,
  };
}

const NETSCAPE =
  "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tsecret\n";

let assign: ReturnType<typeof vi.spyOn>;
let toasts: CapturedToast[];

beforeEach(() => {
  assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
  toasts = captureToasts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeRouter(path = "/accounts"): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/accounts", component: AccountsPage }],
  });
  await router.push(path);
  await router.isReady();
  return router;
}

async function mountPage(server: FakeServer, router?: Router): Promise<VueWrapper> {
  const wrapper = mount(AccountsPage, {
    global: mountGlobals({ api: server.api, router: router ?? (await makeRouter()) }),
  });
  await flush();
  return wrapper;
}

function dialogButton(wrapper: VueWrapper, label: string) {
  const found = wrapper
    .findAll(".p-dialog button")
    .find((candidate) => candidate.text().trim() === label);
  if (found === undefined) throw new Error(`no button labelled ${label}`);
  return found;
}

function card(wrapper: VueWrapper, id: number) {
  return wrapper.find(`[data-account='${id}']`);
}

describe("AccountsPage loading", () => {
  it("renders one card per account with its facts", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({
        rows: [
          account(),
          account({ id: 2, label: "Alt", email: null, status: "pending", last_api_ok_at: null }),
        ],
      }),
    });
    const wrapper = await mountPage(server);
    expect(wrapper.find("h1").text()).toBe("Accounts");
    expect(wrapper.findAll(".account-card")).toHaveLength(2);
    const first = card(wrapper, 1);
    expect(first.find("h2").text()).toBe("Max");
    expect(first.find("[data-fact='email']").text()).toBe("max@example.com");
    expect(first.find("[data-fact='channel']").text()).toBe("UC0123456789abcdefghijkl");
    expect(first.find("[data-fact='cookies']").text()).toBe("Stored");
    expect(first.find("[data-fact='api-ok']").text()).toBe("5 min ago");
    expect(first.find("[data-fact='cookie-ok']").text()).toBe("2 h ago");
    expect(first.find("[data-status='ok']").text()).toBe("OK");
    expect(first.find("[data-fact='budget']").exists()).toBe(false);
    expect(first.find("[data-action='link']").text()).toBe("Re-link Google");
    const second = card(wrapper, 2);
    expect(second.find("[data-fact='email']").text()).toBe("Not linked to Google yet");
    expect(second.find("[data-action='link']").text()).toBe("Link Google account");
  });

  it("shows the scrape budget when the server sends it", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({
        rows: [
          account({ scrape_budget_per_hour: 60 }),
          account({ id: 2, scrape_budget_per_hour: null }),
        ],
      }),
    });
    const wrapper = await mountPage(server);
    expect(card(wrapper, 1).find("[data-fact='budget']").text()).toBe("60 requests/hour");
    expect(card(wrapper, 2).find("[data-fact='budget']").text()).toBe("Global default");
  });

  it("shows the empty state with the setup help expanded", async () => {
    const server = fakeServer({ "GET /api/accounts": () => ({ rows: [] }) });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".empty-state h2").text()).toBe("No accounts yet");
    expect(wrapper.find(".empty-state [data-icon='accounts']").exists()).toBe(true);
    expect(wrapper.text()).toContain("Get cookies.txt LOCALLY");
    expect(wrapper.text()).toContain("/feed/history");
    expect(wrapper.text()).toContain("without logging out");
    expect(wrapper.find("[data-test='callback-url']").text()).toMatch(
      /\/api\/oauth\/google\/callback$/,
    );
  });

  it("shows an error state and retries", async () => {
    let calls = 0;
    const server = fakeServer({
      "GET /api/accounts": () => {
        calls += 1;
        return calls === 1 ? apiError(500, "boom") : { rows: [account()] };
      },
    });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".error-state h2").text()).toBe("Could not load accounts");
    expect(wrapper.find(".error-state__message").text()).toBe("boom");
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.find(".error-state").exists()).toBe(false);
    expect(wrapper.findAll(".account-card")).toHaveLength(1);
  });

  it("mounts without a router", async () => {
    const server = fakeServer({ "GET /api/accounts": () => ({ rows: [] }) });
    const wrapper = mount(AccountsPage, { global: mountGlobals({ api: server.api }) });
    await flush();
    expect(wrapper.find(".empty-state").exists()).toBe(true);
  });
});

describe("AccountsPage OAuth", () => {
  it("navigates the whole page to the OAuth start URL", async () => {
    const server = fakeServer({ "GET /api/accounts": () => ({ rows: [account({ id: 7 })] }) });
    const wrapper = await mountPage(server);
    await card(wrapper, 7).find("[data-action='link']").trigger("click");
    expect(assign).toHaveBeenCalledWith("/api/oauth/google/start?account=7");
  });

  it("prefixes the start URL with the client's base URL", () => {
    const api = createApiClient({ baseUrl: "https://cellar.test" });
    expect(oauthStartUrl(api, 3)).toBe("https://cellar.test/api/oauth/google/start?account=3");
  });

  it("toasts ?linked= and removes it from the URL", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account({ id: 4, label: "Alt", has_cookies: false })] }),
    });
    const router = await makeRouter("/accounts?linked=4&keep=1");
    await mountPage(server, router);
    await flush();
    expect(toasts).toContainEqual(
      expect.objectContaining({
        severity: "success",
        summary: "Google account linked",
        detail: "Alt is linked. Add its cookies.txt next.",
      }),
    );
    expect(router.currentRoute.value.query).toEqual({ keep: "1" });
  });

  it("names an unknown linked account generically", async () => {
    const server = fakeServer({ "GET /api/accounts": () => ({ rows: [account()] }) });
    const router = await makeRouter("/accounts?linked=99");
    await mountPage(server, router);
    await flush();
    expect(toasts[0]).toMatchObject({ detail: "The account is linked." });
  });

  for (const code of Object.keys(OAUTH_ERROR_MESSAGES)) {
    it(`toasts ?error=${code}`, async () => {
      const server = fakeServer({ "GET /api/accounts": () => ({ rows: [] }) });
      const router = await makeRouter(`/accounts?error=${code}`);
      await mountPage(server, router);
      await flush();
      expect(toasts).toContainEqual(
        expect.objectContaining({
          severity: "warn",
          summary: "Linking did not finish",
          detail: OAUTH_ERROR_MESSAGES[code],
        }),
      );
      expect(router.currentRoute.value.query).toEqual({});
    });
  }

  it("falls back to a generic message for an unknown code", () => {
    expect(oauthErrorMessage("weird")).toBe("Linking failed (weird).");
  });

  it("does nothing without OAuth params", async () => {
    const server = fakeServer({ "GET /api/accounts": () => ({ rows: [] }) });
    const router = await makeRouter("/accounts?other=1");
    const replace = vi.spyOn(router, "replace");
    await mountPage(server, router);
    expect(toasts).toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("AccountsPage add and edit", () => {
  it("adds an account and offers the Google link straight away", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [] }),
      "POST /api/accounts": (call) =>
        account({
          id: 12,
          label: (call.body as { label: string }).label,
          email: null,
          status: "pending",
          has_cookies: false,
          last_api_ok_at: null,
          last_cookie_ok_at: null,
        }),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='add-account']").trigger("click");
    await flush();
    expect(wrapper.find("[data-action='save-account']").attributes("disabled")).toBeDefined();
    await wrapper.find("#account-label").setValue("  Partner  ");
    await wrapper.find("[data-action='save-account']").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/accounts")[0]!.body).toEqual({ label: "Partner" });
    expect(wrapper.find("[data-test='account-created']").text()).toContain("Partner");
    expect(wrapper.findAll(".account-card")).toHaveLength(1);
    expect(toasts).toContainEqual(expect.objectContaining({ summary: "Account added" }));
    await wrapper.find("[data-action='link-now']").trigger("click");
    expect(assign).toHaveBeenCalledWith("/api/oauth/google/start?account=12");
  });

  it("shows a create failure inside the dialog", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [] }),
      "POST /api/accounts": () => apiError(400, "Label already in use", "conflict"),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='add-account']").trigger("click");
    await flush();
    await wrapper.find("#account-label").setValue("Max");
    await wrapper.find("[data-action='save-account']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='account-form-error']").text()).toBe("Label already in use");
  });

  it("edits the label and sets a scrape budget", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account()] }),
      "PUT /api/accounts/1": (call) =>
        account({ ...(call.body as object), scrape_budget_per_hour: 90 }),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    expect((wrapper.find("#account-label").element as HTMLInputElement).value).toBe("Max");
    await wrapper.find("#account-label").setValue("Max H");
    wrapper.findComponent(InputNumber).vm.$emit("update:modelValue", 90);
    await wrapper.find("[data-action='save-account']").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/accounts/1")[0]!.body).toEqual({
      label: "Max H",
      scrape_budget_per_hour: 90,
    });
    expect(card(wrapper, 1).find("h2").text()).toBe("Max H");
    expect(card(wrapper, 1).find("[data-fact='budget']").text()).toBe("90 requests/hour");
  });

  it("clears a known budget back to the global default", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account({ scrape_budget_per_hour: 40 })] }),
      "PUT /api/accounts/1": () => account({ scrape_budget_per_hour: null }),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    wrapper.findComponent(InputNumber).vm.$emit("update:modelValue", null);
    await wrapper.find("[data-action='save-account']").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/accounts/1")[0]!.body).toEqual({
      scrape_budget_per_hour: null,
    });
  });

  it("sends nothing for an untouched unknown budget", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account()] }),
      "PUT /api/accounts/1": () => account(),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    await wrapper.find("[data-action='save-account']").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/accounts/1")[0]!.body).toEqual({});
  });
});

describe("AccountsPage status and delete", () => {
  it("disables an active account and enables a disabled one as pending", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account(), account({ id: 2, status: "disabled" })] }),
      "PUT /api/accounts/1": () => account({ status: "disabled" }),
      "PUT /api/accounts/2": () => account({ id: 2, status: "pending" }),
    });
    const wrapper = await mountPage(server);
    expect(card(wrapper, 2).find("[data-action='toggle']").text()).toBe("Enable");
    await card(wrapper, 1).find("[data-action='toggle']").trigger("click");
    await card(wrapper, 2).find("[data-action='toggle']").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/accounts/1")[0]!.body).toEqual({ status: "disabled" });
    expect(server.callsTo("PUT /api/accounts/2")[0]!.body).toEqual({ status: "pending" });
    expect(card(wrapper, 1).find("[data-status='disabled']").exists()).toBe(true);
    expect(card(wrapper, 2).find("[data-status='pending']").exists()).toBe(true);
  });

  it("toasts a failed status change", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account()] }),
      "PUT /api/accounts/1": () => apiError(500, "nope"),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='toggle']").trigger("click");
    await flush();
    expect(toasts).toContainEqual(
      expect.objectContaining({ severity: "error", summary: "Could not disable", detail: "nope" }),
    );
  });

  it("deletes after confirmation", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account(), account({ id: 2, label: "Alt" })] }),
      "DELETE /api/accounts/2": () => noContent(),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 2).find("[data-action='remove']").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").text()).toContain("Delete Alt?");
    await dialogButton(wrapper, "Delete").trigger("click");
    await flush();
    expect(server.callsTo("DELETE /api/accounts/2")).toHaveLength(1);
    expect(card(wrapper, 2).exists()).toBe(false);
    expect(wrapper.find(".confirm-message").exists()).toBe(false);
  });

  it("keeps the account and toasts when delete fails, and cancels cleanly", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account()] }),
      "DELETE /api/accounts/1": () => apiError(500, "locked"),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='remove']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Delete").trigger("click");
    await flush();
    expect(card(wrapper, 1).exists()).toBe(true);
    expect(toasts).toContainEqual(expect.objectContaining({ detail: "locked" }));
    await dialogButton(wrapper, "Cancel").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").exists()).toBe(false);
  });
});

describe("Cookies dialog", () => {
  async function openCookies(server: FakeServer) {
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='cookies']").trigger("click");
    await flush();
    return wrapper;
  }

  it("sends pasted text and shows a passing validation", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account({ has_cookies: false })] }),
      "POST /api/accounts/1/cookies": () => ({
        account: account({ has_cookies: true }),
        validation: { ok: true, detail: "History feed returned 1 entry." },
      }),
    });
    const wrapper = await openCookies(server);
    expect(wrapper.text()).toContain("Cookies for Max");
    expect(wrapper.find("[data-action='save-cookies']").attributes("disabled")).toBeDefined();
    await wrapper.find("#cookies-text").setValue(NETSCAPE);
    expect(wrapper.find("[data-test='cookies-hint']").exists()).toBe(false);
    await wrapper.find("[data-action='save-cookies']").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/accounts/1/cookies")[0]!.body).toEqual({ cookies: NETSCAPE });
    const result = wrapper.find("[data-test='cookies-result']");
    expect(result.attributes("data-ok")).toBe("true");
    expect(result.text()).toContain("Cookies saved and working.");
    expect(result.text()).toContain("History feed returned 1 entry.");
    expect((wrapper.find("#cookies-text").element as HTMLTextAreaElement).value).toBe("");
    expect(card(wrapper, 1).find("[data-fact='cookies']").text()).toBe("Stored");
    expect(dialogButton(wrapper, "Done").exists()).toBe(true);
  });

  it("reads a picked cookies.txt client-side and shows a failing validation", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account()] }),
      "POST /api/accounts/1/cookies": () => ({
        account: account({ status: "cookies_invalid" }),
        validation: { ok: false, detail: "Sign in to confirm you are not a bot" },
      }),
    });
    const wrapper = await openCookies(server);
    const input = wrapper.find("[data-test='cookies-file']");
    const file = new File([NETSCAPE], "cookies.txt", { type: "text/plain" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await flush(5);
    expect((wrapper.find("#cookies-text").element as HTMLTextAreaElement).value).toBe(NETSCAPE);
    expect(wrapper.find("[data-test='cookies-file-name']").text()).toBe("Loaded cookies.txt");
    await wrapper.find("[data-action='save-cookies']").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/accounts/1/cookies")[0]!.body).toEqual({ cookies: NETSCAPE });
    const result = wrapper.find("[data-test='cookies-result']");
    expect(result.attributes("data-ok")).toBe("false");
    expect(result.text()).toContain("validation failed");
    expect(result.text()).toContain("Sign in to confirm you are not a bot");
    expect(card(wrapper, 1).find("[data-status='cookies_invalid']").exists()).toBe(true);
  });

  it("ignores a change event without a file", async () => {
    const server = fakeServer({ "GET /api/accounts": () => ({ rows: [account()] }) });
    const wrapper = await openCookies(server);
    const input = wrapper.find("[data-test='cookies-file']");
    Object.defineProperty(input.element, "files", { value: [], configurable: true });
    await input.trigger("change");
    await flush();
    expect(wrapper.find("[data-test='cookies-file-name']").exists()).toBe(false);
  });

  it("reports a file that cannot be read", async () => {
    const server = fakeServer({ "GET /api/accounts": () => ({ rows: [account()] }) });
    const wrapper = await openCookies(server);
    vi.spyOn(FileReader.prototype, "readAsText").mockImplementation(function (this: FileReader) {
      this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
    });
    const input = wrapper.find("[data-test='cookies-file']");
    Object.defineProperty(input.element, "files", {
      value: [new File(["x"], "bad.txt")],
      configurable: true,
    });
    await input.trigger("change");
    await flush();
    expect(wrapper.find("[data-test='cookies-file-error']").exists()).toBe(true);
  });

  it("hints at text that is not a youtube.com Netscape export", async () => {
    const server = fakeServer({ "GET /api/accounts": () => ({ rows: [account()] }) });
    const wrapper = await openCookies(server);
    await wrapper.find("#cookies-text").setValue("hello");
    expect(wrapper.find("[data-test='cookies-hint']").text()).toContain("youtube.com");
    await wrapper.find("#cookies-text").setValue("youtube.com SID abc");
    expect(wrapper.find("[data-test='cookies-hint']").text()).toContain("Netscape");
  });

  it("shows an upload error and keeps the text", async () => {
    const server = fakeServer({
      "GET /api/accounts": () => ({ rows: [account()] }),
      "POST /api/accounts/1/cookies": () => apiError(400, "Not a cookies.txt file"),
    });
    const wrapper = await openCookies(server);
    await wrapper.find("#cookies-text").setValue(NETSCAPE);
    await wrapper.find("[data-action='save-cookies']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='cookies-error']").text()).toBe("Not a cookies.txt file");
    expect((wrapper.find("#cookies-text").element as HTMLTextAreaElement).value).toBe(NETSCAPE);
  });
});

describe("AccountStatusBadge", () => {
  it("has a label for each of the five states", () => {
    const labels = Object.keys(ACCOUNT_STATUS).map((status) => {
      const wrapper = mount(AccountStatusBadge, {
        props: { status: status as keyof typeof ACCOUNT_STATUS },
        global: mountGlobals(),
      });
      return wrapper.text();
    });
    expect(labels).toEqual(["OK", "Pending", "Google link lost", "Cookies invalid", "Disabled"]);
  });
});
