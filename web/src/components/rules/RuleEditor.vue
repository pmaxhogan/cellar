<script setup lang="ts">
import { computed, ref, useId } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import ToggleSwitch from "primevue/toggleswitch";
import {
  matchAll,
  type AstError,
  type ConditionNode,
  type RuleKind,
  type RuleRow,
} from "@cellar/shared";
import { useApi } from "../../api/provide.ts";
import { createRule, updateRule, type RuleDraftBody } from "../../api/rules.ts";
import { normalizeError } from "../../api/client.ts";
import { useRuleLookups } from "../../lib/rulesLookups.ts";
import ConditionTree from "./ConditionTree.vue";
import EffectsEditor from "./EffectsEditor.vue";
import RulePreviewPanel from "./RulePreviewPanel.vue";

/**
 * Create or edit one rule: name, enabled, the condition builder (custom rules
 * only; the global rule applies to every video) and the sparse effects. The
 * preview panel counts matches as the condition changes. Saving POSTs a new
 * custom rule or PUTs the edited one, and emits the stored row.
 */
const props = withDefaults(
  defineProps<{
    /** The rule to edit; null creates a custom rule. */
    rule: RuleRow | null;
    /** Position for a new rule (the end of the list = the highest priority). */
    nextPosition?: number;
  }>(),
  { nextPosition: 1 },
);
const emit = defineEmits<{ saved: [RuleRow]; cancel: [] }>();

const api = useApi();
useRuleLookups();
const kind = computed<RuleKind>(() => props.rule?.kind ?? "custom");
const isGlobal = computed(() => kind.value === "global");
const nameId = useId();
const enabledId = useId();

function cloneEffects(effects: unknown): Record<string, unknown> {
  return effects !== null && typeof effects === "object"
    ? (JSON.parse(JSON.stringify(effects)) as Record<string, unknown>)
    : {};
}

const name = ref(props.rule?.name ?? "");
const enabled = ref(props.rule?.enabled ?? true);
const condition = ref<ConditionNode | null>(
  kind.value === "custom" ? ((props.rule?.condition as ConditionNode | null) ?? matchAll()) : null,
);
const effects = ref<Record<string, unknown>>(cloneEffects(props.rule?.effects));
const conditionErrors = ref<AstError[]>([]);
const effectsValid = ref(true);
const saving = ref(false);
const saveError = ref<string | null>(null);

const conditionValid = computed(() => conditionErrors.value.length === 0);
const nameError = computed(() => {
  const trimmed = name.value.trim();
  return trimmed === "" ? "Give the rule a name." : null;
});
const canSave = computed(
  () => nameError.value === null && conditionValid.value && effectsValid.value && !saving.value,
);

function draft(): RuleDraftBody {
  return {
    kind: kind.value,
    video_id: null,
    position: props.rule?.position ?? props.nextPosition,
    name: name.value.trim(),
    enabled: enabled.value,
    condition: isGlobal.value ? null : condition.value,
    effects: effects.value,
  };
}

async function save(): Promise<void> {
  if (!canSave.value) return;
  // The server validates the draft with the same shared RuleDraftSchema.
  const body = draft();
  saving.value = true;
  saveError.value = null;
  try {
    const row =
      props.rule === null
        ? await createRule(api, body)
        : await updateRule(api, props.rule.id, body);
    emit("saved", row);
  } catch (cause) {
    saveError.value = normalizeError(cause).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="rule-editor" data-test="rule-editor" @submit.prevent="save">
    <div class="rule-editor__main cellar-stack">
      <section class="cellar-card cellar-stack">
        <div class="rule-editor__meta">
          <div class="cellar-field rule-editor__name">
            <label :for="nameId">Name</label>
            <InputText
              :id="nameId"
              v-model="name"
              :invalid="nameError !== null"
              maxlength="200"
              data-test="rule-name"
            />
            <small v-if="nameError" class="rule-editor__error" data-test="name-error">
              {{ nameError }}
            </small>
          </div>
          <div class="rule-editor__enabled">
            <ToggleSwitch v-model="enabled" :input-id="enabledId" data-test="rule-enabled" />
            <label :for="enabledId">Enabled</label>
          </div>
        </div>
      </section>

      <section v-if="!isGlobal" class="cellar-card">
        <h3>Condition</h3>
        <ConditionTree
          v-model="condition"
          @validity="(errors: AstError[]) => (conditionErrors = errors)"
        />
      </section>
      <p v-else class="cellar-note" data-test="global-note">
        The global rule has no condition: it applies to every video, at the lowest priority. It
        cannot exclude videos; use a custom rule for that.
      </p>

      <section class="cellar-card">
        <h3>Effects</h3>
        <EffectsEditor
          v-model="effects"
          :kind="kind"
          @validity="(valid: boolean) => (effectsValid = valid)"
        />
      </section>

      <p v-if="saveError" class="rule-editor__error" role="alert" data-test="save-error">
        {{ saveError }}
      </p>
      <div class="rule-editor__actions">
        <Button
          label="Cancel"
          severity="secondary"
          text
          type="button"
          data-test="rule-cancel"
          @click="emit('cancel')"
        />
        <Button
          :label="rule === null ? 'Create rule' : 'Save rule'"
          type="submit"
          :loading="saving"
          :disabled="!canSave"
          data-test="rule-save"
        />
      </div>
    </div>
    <RulePreviewPanel
      v-if="!isGlobal"
      class="rule-editor__preview"
      :condition="condition"
      :valid="conditionValid"
    />
  </form>
</template>

<style scoped>
.rule-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 20rem;
  gap: 1rem;
  align-items: start;
}

.rule-editor h3 {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
}

.rule-editor__meta {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
  flex-wrap: wrap;
}

.rule-editor__name {
  flex: 1;
  min-width: 16rem;
}

.rule-editor__enabled {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding-bottom: 0.4rem;
}

.rule-editor__error {
  color: var(--cellar-error);
  margin: 0;
}

.rule-editor__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.rule-editor__preview {
  position: sticky;
  top: 0;
}

@media (max-width: 1000px) {
  .rule-editor {
    grid-template-columns: minmax(0, 1fr);
  }

  .rule-editor__preview {
    position: static;
  }
}
</style>
