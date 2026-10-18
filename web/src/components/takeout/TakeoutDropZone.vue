<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import { TAKEOUT_ACCEPT } from "@cellar/shared";
import AppIcon from "../AppIcon.vue";
import { isAcceptedFile } from "../../api/takeout.ts";

/**
 * Drop zone plus file picker for Takeout archives and loose export files.
 * Accepted files are emitted as `add`; anything else is reported by name as
 * `rejected` so the page can say why it was ignored.
 */
const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ add: [File[]]; rejected: [string[]] }>();

const input = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

function take(list: FileList | File[] | null | undefined): void {
  const files = list === null || list === undefined ? [] : [...list];
  const accepted = files.filter((file) => isAcceptedFile(file.name));
  const rejected = files.filter((file) => !isAcceptedFile(file.name)).map((file) => file.name);
  if (accepted.length > 0) emit("add", accepted);
  if (rejected.length > 0) emit("rejected", rejected);
}

function onPick(event: Event): void {
  const target = event.target as HTMLInputElement;
  take(target.files);
  // Picking the same file again must fire change again.
  target.value = "";
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  if (props.disabled === true) return;
  take(event.dataTransfer?.files);
}

function onDragOver(event: DragEvent): void {
  if (props.disabled === true) return;
  dragging.value = true;
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
}
</script>

<template>
  <div
    class="takeout-drop"
    :class="{ 'takeout-drop--active': dragging, 'takeout-drop--disabled': disabled }"
    data-test="takeout-drop"
    @dragover.prevent="onDragOver"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <AppIcon name="folder" :size="28" />
    <p>Drop the Takeout archive here, or the files inside it.</p>
    <p class="cellar-note">
      .tgz, .tar.gz, .zip, watch-history.json and *.csv; up to 2 GB in total.
    </p>
    <input
      ref="input"
      class="sr-only"
      type="file"
      multiple
      :accept="TAKEOUT_ACCEPT"
      :disabled="disabled"
      data-test="takeout-file"
      @change="onPick"
    />
    <Button
      label="Choose files"
      size="small"
      severity="secondary"
      :disabled="disabled"
      data-action="choose-files"
      @click="input?.click()"
    />
  </div>
</template>

<style scoped>
.takeout-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 1.5rem 1rem;
  border: 2px dashed var(--p-content-border-color);
  border-radius: 10px;
  text-align: center;
  color: var(--p-text-muted-color);
}

.takeout-drop p {
  margin: 0;
}

.takeout-drop--active {
  border-color: var(--p-primary-color);
  color: var(--p-text-color);
}

.takeout-drop--disabled {
  opacity: 0.6;
}
</style>
