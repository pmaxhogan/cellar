import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { StatusResponse } from "@cellar/shared";
import { normalizeError, type ApiClient, type ApiClientError } from "../api/client.ts";
import type { CellarEvent } from "../api/types.ts";

/** How long to coalesce event-driven status refreshes. */
export const STATUS_REFRESH_DEBOUNCE_MS = 1_500;

export type StatusTone = "idle" | "busy" | "warn" | "error";

export const useStatusStore = defineStore("status", () => {
  const status = ref<StatusResponse | null>(null);
  const loading = ref(false);
  const error = ref<ApiClientError | null>(null);
  let client: ApiClient | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const insecureMode = computed(() => status.value?.insecureMode === true);
  const dbOk = computed(() => status.value?.db.ok !== false);

  /** Tools the server could not find a version for, by display name. */
  const missingTools = computed(() => {
    const tools = status.value?.tools;
    if (tools === undefined) return [];
    const missing: string[] = [];
    if (tools.ytdlp === null) missing.push("yt-dlp");
    if (tools.ffmpeg === null) missing.push("ffmpeg");
    return missing;
  });

  /** One short phrase for the nav status pill. */
  const summary = computed(() => {
    if (error.value !== null) return "status unavailable";
    if (status.value === null) return "connecting";
    if (!dbOk.value) return "database error";
    if (missingTools.value.length > 0) return `${missingTools.value.join(", ")} missing`;
    return "ready";
  });

  const tone = computed<StatusTone>(() => {
    if (error.value !== null || !dbOk.value) return "error";
    if (missingTools.value.length > 0) return "warn";
    return "idle";
  });

  async function load(next?: ApiClient): Promise<void> {
    if (next !== undefined) client = next;
    if (client === null) return;
    loading.value = true;
    try {
      status.value = await client.status();
      error.value = null;
    } catch (cause) {
      error.value = normalizeError(cause);
    } finally {
      loading.value = false;
    }
  }

  function scheduleRefresh(): void {
    if (debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      void load();
    }, STATUS_REFRESH_DEBOUNCE_MS);
  }

  /**
   * No event carries status fields yet, so any event only says that something
   * moved; bursts coalesce into one refetch.
   */
  function applyEvent(_event: CellarEvent): void {
    scheduleRefresh();
  }

  return {
    status,
    loading,
    error,
    insecureMode,
    dbOk,
    missingTools,
    summary,
    tone,
    load,
    applyEvent,
  };
});
