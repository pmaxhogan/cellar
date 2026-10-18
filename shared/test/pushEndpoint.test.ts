import { describe, expect, it } from "vitest";
import { isAllowedPushEndpoint, PushSubscriptionInputSchema } from "../src/apiTypes.ts";

describe("isAllowedPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/xyz",
    "https://web.push.apple.com/QAbc",
    "https://wns2-par02p.notify.windows.com/w/?token=1",
    "https://api.push.apple.com/3/device/x",
    "HTTPS://FCM.GOOGLEAPIS.COM/x",
    "https://fcm.googleapis.com./trailing-dot",
    "https://fcm.googleapis.com",
    "https://fcm.googleapis.com?x=1",
    "https://fcm.googleapis.com#frag",
  ])("accepts %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/x",
    "https://fcm.googleapis.com:443/x",
    "https://fcm.googleapis.com:8443/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://evil.example@fcm.googleapis.com/x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilfcm.googleapis.com/x",
    "https://notify.windows.com/x",
    "https://push.apple.com/x",
    "https://evil.example/x?fcm.googleapis.com",
    "https://fcm.googleapis.com\\.evil.example/x",
    "https://fcm%2Egoogleapis.com/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https:/fcm.googleapis.com/x",
    "not a url",
    "",
  ])("rejects %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it("is enforced by the subscription schema", () => {
    const keys = { p256dh: "p", auth: "a" };
    expect(
      PushSubscriptionInputSchema.safeParse({ endpoint: "https://fcm.googleapis.com/x", keys })
        .success,
    ).toBe(true);
    const rejected = PushSubscriptionInputSchema.safeParse({
      endpoint: "https://169.254.169.254/latest/meta-data",
      keys,
    });
    expect(rejected.success).toBe(false);
  });
});
