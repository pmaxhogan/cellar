import { createApp } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import ConfirmationService from "primevue/confirmationservice";
import ToastService from "primevue/toastservice";
import App from "./App.vue";
import { router } from "./router/index.ts";
import { DARK_MODE_SELECTOR, cellarPreset } from "./theme/cellar-preset.ts";
import "./assets/main.css";

// Dark is the default; the theme store removes the class when the persisted
// preference is light. index.html already carries it, so this only matters if
// that markup ever changes, and it avoids a light flash before hydration.
document.documentElement.classList.add(DARK_MODE_SELECTOR.slice(1));

createApp(App)
  .use(createPinia())
  .use(router)
  .use(PrimeVue, {
    theme: {
      preset: cellarPreset,
      options: {
        darkModeSelector: DARK_MODE_SELECTOR,
        cssLayer: false,
      },
    },
  })
  .use(ToastService)
  .use(ConfirmationService)
  .mount("#app");
