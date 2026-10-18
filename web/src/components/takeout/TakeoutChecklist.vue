<script setup lang="ts">
/**
 * The exact Google Takeout export steps. History is the one product with a
 * format choice, and its default (HTML) is the one cellar cannot read, so
 * that step is called out.
 */
interface TakeoutStep {
  text: string;
  /** Rendered as a warning: getting it wrong makes the export unusable. */
  important?: boolean;
}

const STEPS: TakeoutStep[] = [
  { text: "Google Takeout" },
  { text: "Deselect all" },
  { text: "tick 'YouTube and YouTube Music'" },
  { text: "'All YouTube data included'" },
  { text: "keep only history, playlists, subscriptions" },
  { text: "'Multiple formats'" },
  {
    text: "set history to JSON (the default HTML cannot be imported; playlists and subscriptions are CSV only)",
    important: true,
  },
  { text: "export (a .tgz or .zip)" },
];

const TAKEOUT_URL = "https://takeout.google.com/";
</script>

<template>
  <section class="cellar-card takeout-checklist" aria-labelledby="takeout-checklist-title">
    <h2 id="takeout-checklist-title">Export from Google Takeout</h2>
    <ol class="takeout-checklist__steps" data-test="takeout-steps">
      <li
        v-for="(step, index) in STEPS"
        :key="index"
        :class="{ 'takeout-checklist__step--important': step.important }"
      >
        <a
          v-if="index === 0"
          :href="TAKEOUT_URL"
          target="_blank"
          rel="noopener noreferrer"
          data-test="takeout-link"
          >{{ step.text }}</a
        >
        <template v-else>{{ step.text }}</template>
      </li>
    </ol>
    <p class="cellar-note">
      Upload the whole archive (every part, if Takeout split it), or just the files inside it:
      watch-history.json, the playlist CSVs and subscriptions.csv. Watch later and Liked videos
      become sources; other playlists are counted but not imported.
    </p>
  </section>
</template>

<style scoped>
.takeout-checklist h2 {
  margin: 0 0 0.6rem;
  font-size: 1rem;
  font-weight: 650;
}

.takeout-checklist__steps {
  margin: 0;
  padding-left: 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.takeout-checklist__step--important {
  font-weight: 600;
  color: var(--cellar-warn, var(--p-text-color));
}
</style>
