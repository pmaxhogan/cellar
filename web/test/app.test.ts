import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "../src/App.vue";

describe("App", () => {
  it("renders the title", () => {
    expect(mount(App).text()).toContain("Cellar");
  });
});
