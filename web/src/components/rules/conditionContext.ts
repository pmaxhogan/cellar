import { inject, type ComputedRef, type InjectionKey, type Ref } from "vue";
import type { AstError, Field } from "@cellar/shared";
import type { UiGroup, UiLeaf, UiNode } from "../../lib/rulesTree.ts";

/**
 * What ConditionTree hands down to its groups and leaves. Every edit goes
 * through these methods so the tree has one owner and the components never
 * mutate their props.
 */
export interface ConditionContext {
  root: Ref<UiGroup>;
  errors: ComputedRef<Map<number, AstError[]>>;
  /** The node being dragged, while a drag is in progress. */
  dragging: Ref<UiNode | null>;
  disabled: ComputedRef<boolean>;
  setField: (leaf: UiLeaf, field: Field) => void;
  setOp: (leaf: UiLeaf, op: string) => void;
  setValue: (leaf: UiLeaf, value: unknown) => void;
  setCi: (leaf: UiLeaf, ci: boolean) => void;
  setSource: (leaf: UiLeaf, source: string | null) => void;
  setGroupOp: (group: UiGroup, op: "and" | "or") => void;
  setNot: (group: UiGroup, not: boolean) => void;
  addLeaf: (group: UiGroup) => void;
  addGroup: (group: UiGroup) => void;
  remove: (node: UiNode) => void;
  /** Drops the dragged node into `group` before `before` (null = at the end). */
  dropInto: (group: UiGroup, before: UiNode | null) => void;
  shift: (node: UiNode, delta: -1 | 1) => void;
}

export const conditionContextKey: InjectionKey<ConditionContext> = Symbol("cellar.condition");

/** The context of the enclosing ConditionTree; groups and leaves only render inside one. */
export function useConditionContext(): ConditionContext {
  return inject(conditionContextKey) as ConditionContext;
}
