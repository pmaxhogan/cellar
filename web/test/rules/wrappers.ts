import type { VueWrapper } from "@vue/test-utils";

interface Searchable {
  findAllComponents(selector: string): unknown[];
}

/**
 * The component whose root element carries `data-test`, typed as a
 * VueWrapper (test-utils types string-selector results loosely). PrimeVue
 * components pass `data-test` through to their root element.
 */
export function byTest(within: Searchable, test: string, index = 0): VueWrapper {
  const found = within.findAllComponents(`[data-test='${test}']`)[index];
  if (found === undefined) throw new Error(`no component [data-test='${test}'] #${index}`);
  return found as VueWrapper;
}

/** One prop of a component wrapper, untyped. */
export function propOf(wrapper: VueWrapper, name: string): unknown {
  return (wrapper.props() as Record<string, unknown>)[name];
}
