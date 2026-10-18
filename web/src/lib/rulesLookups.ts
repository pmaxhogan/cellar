import { computed, inject, provide, reactive, ref, type InjectionKey, type Ref } from "vue";
import type { AccountRow, ChannelRow, LocationRow, ProxyRow } from "@cellar/shared";
import type { ApiClient } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  fetchCodecSupport,
  listAccounts,
  listLocations,
  listProxies,
  searchChannels,
  type CodecSupport,
} from "../api/rules.ts";
import type { SummaryLabels } from "./ruleSummary.ts";

/**
 * Shared, lazily loaded reference data for the rule builder and effects
 * editor: locations, accounts, proxies, NVENC support, and the titles of
 * channels seen through autocomplete. One instance is provided per page so a
 * dozen leaves asking for the location list cause one request.
 */
export interface RuleLookups {
  locations: Ref<LocationRow[]>;
  accounts: Ref<AccountRow[]>;
  proxies: Ref<ProxyRow[]>;
  codecs: Ref<CodecSupport>;
  /** channel id -> display title, filled by autocomplete results. */
  channelTitles: Map<string, string>;
  labels: Ref<SummaryLabels>;
  ensureLocations: () => Promise<void>;
  ensureAccounts: () => Promise<void>;
  ensureProxies: () => Promise<void>;
  ensureCodecs: () => Promise<void>;
  searchChannels: (q: string) => Promise<ChannelRow[]>;
}

export const ruleLookupsKey: InjectionKey<RuleLookups> = Symbol("cellar.ruleLookups");

function once(load: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    pending ??= load().catch(() => {
      // A failed lookup leaves the list empty; the next ensure retries.
      pending = null;
    });
    return pending;
  };
}

export function channelDisplay(row: Pick<ChannelRow, "id" | "title" | "handle">): string {
  return row.title ?? row.handle ?? row.id;
}

export function createRuleLookups(api: ApiClient): RuleLookups {
  const locations = ref<LocationRow[]>([]);
  const accounts = ref<AccountRow[]>([]);
  const proxies = ref<ProxyRow[]>([]);
  const codecs = ref<CodecSupport>({});
  const channelTitles = reactive(new Map<string, string>());

  const labels = computed<SummaryLabels>(() => ({
    locations: new Map(locations.value.map((row) => [row.id, row.label])),
    accounts: new Map(accounts.value.map((row) => [row.id, row.label])),
    proxies: new Map(proxies.value.map((row) => [row.id, row.label])),
    channels: new Map(channelTitles),
  }));

  return {
    locations,
    accounts,
    proxies,
    codecs,
    channelTitles,
    labels,
    ensureLocations: once(async () => {
      locations.value = await listLocations(api);
    }),
    ensureAccounts: once(async () => {
      accounts.value = await listAccounts(api);
    }),
    ensureProxies: once(async () => {
      proxies.value = await listProxies(api);
    }),
    ensureCodecs: once(async () => {
      codecs.value = await fetchCodecSupport(api);
    }),
    async searchChannels(q: string): Promise<ChannelRow[]> {
      const rows = await searchChannels(api, q);
      for (const row of rows) channelTitles.set(row.id, channelDisplay(row));
      return rows;
    },
  };
}

/** Creates and provides a lookups instance for the subtree. */
export function provideRuleLookups(api: ApiClient): RuleLookups {
  const lookups = createRuleLookups(api);
  provide(ruleLookupsKey, lookups);
  return lookups;
}

/** The provided lookups, or a private instance when a component is used on its own. */
export function useRuleLookups(): RuleLookups {
  const provided = inject(ruleLookupsKey, null);
  return provided ?? createRuleLookups(useApi());
}
