import { expect, test } from "@playwright/test";

test("healthz answers", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.ok()).toBe(true);
});
