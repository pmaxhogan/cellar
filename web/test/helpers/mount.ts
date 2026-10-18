import { createPinia, type Pinia } from "pinia";
import PrimeVue from "primevue/config";
import ConfirmationService from "primevue/confirmationservice";
import ToastService from "primevue/toastservice";
import type { Plugin } from "vue";
import type { Router } from "vue-router";
import type { ApiClient } from "../../src/api/client.ts";
import { apiKey } from "../../src/api/provide.ts";
import { DARK_MODE_SELECTOR, cellarPreset } from "../../src/theme/cellar-preset.ts";
import { stubApi } from "./stubApi.ts";

type PluginEntry = Plugin | [Plugin, ...unknown[]];

/**
 * Everything a component under test needs: a pinia (fresh unless one is passed
 * in so the test can reach the same stores), the real PrimeVue theme (its
 * components read the theme config on render), the toast and confirmation
 * services, and a stubbed API client provided through the injection key.
 */
export function mountGlobals(options: { api?: ApiClient; router?: Router; pinia?: Pinia } = {}) {
  const plugins: PluginEntry[] = [
    options.pinia ?? createPinia(),
    [
      PrimeVue as Plugin,
      {
        theme: {
          preset: cellarPreset,
          options: { darkModeSelector: DARK_MODE_SELECTOR, cssLayer: false },
        },
      },
    ],
    ToastService as Plugin,
    ConfirmationService as Plugin,
  ];
  if (options.router !== undefined) plugins.push(options.router as unknown as Plugin);

  return {
    plugins,
    provide: { [apiKey as symbol]: options.api ?? stubApi() },
    stubs: { teleport: true },
  };
}
