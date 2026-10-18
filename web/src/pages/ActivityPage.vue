<script setup lang="ts">
import { ref } from "vue";
import Tab from "primevue/tab";
import TabList from "primevue/tablist";
import TabPanel from "primevue/tabpanel";
import TabPanels from "primevue/tabpanels";
import Tabs from "primevue/tabs";
import type { JobRow } from "../api/jobs.ts";
import PageHeader from "../components/PageHeader.vue";
import ActionsToolbar from "../components/activity/ActionsToolbar.vue";
import ActivityLogTable from "../components/activity/ActivityLogTable.vue";
import JobDetailDrawer from "../components/activity/JobDetailDrawer.vue";
import JobsTable from "../components/activity/JobsTable.vue";

type TabKey = "activity" | "jobs";

const tab = ref<TabKey>("activity");
const drawerVisible = ref(false);
const drawerJobId = ref<number | null>(null);
const drawerInitial = ref<JobRow | null>(null);
const jobsTable = ref<InstanceType<typeof JobsTable> | null>(null);

function openJob(job: JobRow): void {
  drawerInitial.value = job;
  drawerJobId.value = job.id;
  drawerVisible.value = true;
}

function openJobId(id: number): void {
  drawerInitial.value = null;
  drawerJobId.value = id;
  drawerVisible.value = true;
}

/** A manual action queued a job: show it at the top of the jobs tab. */
function onQueued(): void {
  void jobsTable.value?.load();
}

function onTab(value: string | number): void {
  tab.value = value === "jobs" ? "jobs" : "activity";
}
</script>

<template>
  <section>
    <PageHeader
      title="Activity"
      description="Jobs, their logs, and what the scheduler is doing right now."
    />

    <ActionsToolbar @queued="onQueued" />

    <Tabs :value="tab" @update:value="onTab">
      <TabList>
        <Tab value="activity" data-tab="activity">Activity</Tab>
        <Tab value="jobs" data-tab="jobs">Jobs</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="activity">
          <ActivityLogTable @open-job="openJobId" />
        </TabPanel>
        <TabPanel value="jobs">
          <JobsTable ref="jobsTable" @open="openJob" />
        </TabPanel>
      </TabPanels>
    </Tabs>

    <JobDetailDrawer
      v-model:visible="drawerVisible"
      :job-id="drawerJobId"
      :initial="drawerInitial"
    />
  </section>
</template>
