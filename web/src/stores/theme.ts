import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { DARK_MODE_SELECTOR } from "../theme/cellar-preset.ts";

export const THEME_STORAGE_KEY = "cellar.color-scheme";

const DARK_CLASS = DARK_MODE_SELECTOR.slice(1);

/** Dark unless the user has explicitly chosen light. */
export function readStoredPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(THEME_STORAGE_KEY) !== "light";
  } catch {
    // Private-mode storage denial is not worth a broken app.
    return true;
  }
}

/**
 * Cellar is dark-first: the dark class sits on <html> from boot and a stored
 * light preference removes it, not the other way around.
 */
export const useThemeStore = defineStore("theme", () => {
  const dark = ref(readStoredPreference());

  function apply(): void {
    const root = globalThis.document?.documentElement;
    if (root === undefined) return;
    root.classList.toggle(DARK_CLASS, dark.value);
    root.style.colorScheme = dark.value ? "dark" : "light";
  }

  watch(
    dark,
    (value) => {
      apply();
      try {
        globalThis.localStorage?.setItem(THEME_STORAGE_KEY, value ? "dark" : "light");
      } catch {
        // Ignore: the toggle still works for this session.
      }
    },
    { immediate: true },
  );

  function toggle(): void {
    dark.value = !dark.value;
  }

  return { dark, toggle };
});
