<script lang="ts" setup>
import { ref, onMounted } from 'vue';
import { browser } from 'wxt/browser';
import { jiraCreds, teams } from '@/shared/storage';
import type { TeamBoard } from '@/core/domain';

const boards = ref<TeamBoard[]>([]);
const jiraBase = ref('https://tvbet.atlassian.net');
onMounted(async () => {
  boards.value = (await teams.getValue()).filter((t) => t.enabled);
  const creds = await jiraCreds.getValue();
  if (creds?.baseUrl) jiraBase.value = creds.baseUrl;
});

function open(url: string) {
  void browser.tabs.create({ url });
  window.close();
}
function boardUrl(t: TeamBoard) {
  return t.projectKey
    ? `${jiraBase.value}/jira/software/c/projects/${t.projectKey}/boards/${t.rapidViewId}/backlog`
    : `${jiraBase.value}/secure/RapidBoard.jspa?rapidView=${t.rapidViewId}&view=planning`;
}
function openOptions() {
  void browser.runtime.openOptionsPage();
  window.close();
}
</script>

<template>
  <main class="w-80 bg-white p-4 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
    <header class="mb-3 flex items-center gap-2">
      <span
        class="grid size-7 place-items-center rounded-md bg-indigo-600 text-sm font-bold text-white"
      >
        TL
      </span>
      <h1 class="text-base font-semibold">Team Lead Helper</h1>
    </header>

    <p class="mb-4 text-sm text-slate-500 dark:text-slate-400">
      Сколько взять в спринт, куда ушли SP и как идёт квартал - на доске Jira и в отчёте.
    </p>

    <div class="flex flex-col gap-2">
      <button
        type="button"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
        @click="open(browser.runtime.getURL('/sprint-report.html'))"
      >
        Открыть отчёт
      </button>
      <div v-if="boards.length" class="mt-1">
        <span class="mb-1 block text-xs text-slate-500 dark:text-slate-400">Доски в Jira</span>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="t in boards"
            :key="t.rapidViewId"
            type="button"
            class="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            @click="open(boardUrl(t))"
          >
            {{ t.name }}
          </button>
        </div>
      </div>
      <button
        type="button"
        class="rounded-md px-3 py-2 text-sm font-medium text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        @click="openOptions"
      >
        Открыть настройки
      </button>
    </div>
  </main>
</template>
