<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import { effectRegistry, type EffectKey, type RuleKind } from "@cellar/shared";
import {
  addableEffects,
  effectErrors,
  initialEffectValue,
  setKeys,
} from "../../lib/rulesEffects.ts";
import { useRuleLookups } from "../../lib/rulesLookups.ts";
import EffectControl from "./EffectControl.vue";

/**
 * Sparse effects editor. Each effect key is either unset (the rule inherits
 * it from lower-priority rules and the defaults) or set to a value this rule
 * imposes. "Add effect" offers only the keys the rule kind may set (the global
 * rule never sees `include`); "Inherit" unsets a key again.
 */
const props = withDefaults(
  defineProps<{ modelValue: Record<string, unknown>; kind: RuleKind; disabled?: boolean }>(),
  { disabled: false },
);
const emit = defineEmits<{
  "update:modelValue": [Record<string, unknown>];
  validity: [boolean];
}>();

useRuleLookups();
const keys = computed(() => setKeys(props.modelValue));
const groups = computed(() => addableEffects(props.kind, keys.value));
const errors = computed(() => effectErrors(props.modelValue, props.kind));
const adding = ref<EffectKey | null>(null);

watch(errors, (next) => emit("validity", next.size === 0), { immediate: true });

function add(key: EffectKey | null): void {
  if (key === null) return;
  emit("update:modelValue", { ...props.modelValue, [key]: initialEffectValue(key) });
  adding.value = null;
}

function set(key: EffectKey, value: unknown): void {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}

function unset(key: EffectKey): void {
  const next = { ...props.modelValue };
  delete next[key];
  emit("update:modelValue", next);
}
</script>

<template>
  <div class="effects-editor" data-test="effects-editor">
    <p v-if="keys.length === 0" class="cellar-note" data-test="effects-empty">
      No effects set. Every setting is inherited from lower-priority rules and the defaults.
    </p>
    <ul v-else class="effects-editor__list">
      <li
        v-for="key in keys"
        :key="key"
        class="effect-row"
        :class="{ 'effect-row--invalid': errors.has(key) }"
        :data-effect="key"
      >
        <div class="effect-row__head">
          <div>
            <strong>{{ effectRegistry[key].ui.label }}</strong>
            <p class="cellar-note">{{ effectRegistry[key].ui.description }}</p>
          </div>
          <Button
            label="Inherit"
            size="small"
            text
            severity="secondary"
            :disabled="disabled"
            :aria-label="`Stop setting ${effectRegistry[key].ui.label}`"
            data-test="effect-unset"
            @click="unset(key)"
          />
        </div>
        <EffectControl
          :effect-key="key"
          :model-value="modelValue[key]"
          :disabled="disabled"
          @update:model-value="(v: unknown) => set(key, v)"
        />
        <ul v-if="errors.has(key)" class="effect-row__errors">
          <li v-for="message in errors.get(key)" :key="message" data-test="effect-error">
            {{ message }}
          </li>
        </ul>
      </li>
    </ul>
    <ul v-if="errors.has('')" class="effect-row__errors">
      <li v-for="message in errors.get('')" :key="message" data-test="effect-error">
        {{ message }}
      </li>
    </ul>
    <Select
      v-if="groups.length > 0"
      v-model="adding"
      :options="groups"
      option-label="label"
      option-value="key"
      option-group-label="label"
      option-group-children="items"
      placeholder="Add effect"
      size="small"
      class="effects-editor__add"
      :disabled="disabled"
      aria-label="Add effect"
      data-test="effect-add"
      @update:model-value="add"
    />
  </div>
</template>

<style scoped>
.effects-editor {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.effects-editor__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.effect-row {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}

.effect-row--invalid {
  border-color: var(--cellar-error-border);
}

.effect-row__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
}

.effect-row__errors {
  margin: 0;
  padding-left: 1.1rem;
  color: var(--cellar-error);
  font-size: 0.82rem;
}

.effects-editor__add {
  align-self: flex-start;
  min-width: 14rem;
}
</style>
