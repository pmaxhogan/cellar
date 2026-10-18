import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import ThemeToggle from "../src/components/ThemeToggle.vue";
import { THEME_STORAGE_KEY, readStoredPreference, useThemeStore } from "../src/stores/theme.ts";

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  root.className = "";
  root.style.colorScheme = "";
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme store", () => {
  it("defaults to dark with nothing stored", () => {
    const theme = useThemeStore();
    expect(theme.dark).toBe(true);
    expect(root.classList.contains("cellar-dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("honors a stored light preference on boot", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    root.classList.add("cellar-dark");
    const theme = useThemeStore();
    expect(theme.dark).toBe(false);
    expect(root.classList.contains("cellar-dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
  });

  it("treats any unknown stored value as dark", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(useThemeStore().dark).toBe(true);
  });

  it("toggles, applies and persists", async () => {
    const theme = useThemeStore();
    theme.toggle();
    await nextTick();
    expect(root.classList.contains("cellar-dark")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    theme.toggle();
    await nextTick();
    expect(root.classList.contains("cellar-dark")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("survives storage that throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readStoredPreference()).toBe(true);
    const theme = useThemeStore();
    theme.toggle();
    await nextTick();
    expect(root.classList.contains("cellar-dark")).toBe(false);
  });
});

describe("ThemeToggle", () => {
  it("labels itself for the mode it switches to and flips on click", async () => {
    const wrapper = mount(ThemeToggle, { global: { plugins: [createPinia()] } });
    const button = wrapper.get("button");
    expect(button.attributes("aria-label")).toBe("Switch to light mode");
    expect(button.attributes("aria-pressed")).toBe("true");
    expect(wrapper.find("[data-icon='moon']").exists()).toBe(true);

    await button.trigger("click");
    expect(button.attributes("aria-label")).toBe("Switch to dark mode");
    expect(button.attributes("aria-pressed")).toBe("false");
    expect(wrapper.find("[data-icon='sun']").exists()).toBe(true);
    expect(root.classList.contains("cellar-dark")).toBe(false);
  });
});
