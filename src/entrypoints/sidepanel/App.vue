<script lang="ts" setup>
import { ref, onMounted } from 'vue';
import { browser } from 'wxt/browser';
import { boardConfig } from '@/shared/storage';

const rapidViewId = ref(80);
onMounted(async () => {
  rapidViewId.value = (await boardConfig.getValue()).rapidViewId;
});

function openBoard() {
  void browser.tabs.create({
    url: `https://tvbet.atlassian.net/jira/software/c/projects/ELCAS/boards/${rapidViewId.value}/backlog`,
  });
}
function openOptions() {
  browser.runtime.openOptionsPage();
}
</script>

<template>
  <div class="flex h-screen flex-col bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
    <header
      class="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800"
    >
      <span
        class="grid size-7 place-items-center rounded-md bg-indigo-600 text-sm font-bold text-white"
      >
        TL
      </span>
      <h1 class="text-sm font-semibold">Team Lead Helper</h1>
    </header>

    <main class="flex-1 overflow-y-auto p-4">
      <section class="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <h2 class="mb-1 text-sm font-medium">CAP-распределение и квартальный баланс</h2>
        <p class="text-sm text-slate-500 dark:text-slate-400">
          Показываются прямо на доске под заголовком каждого спринта и в блоке квартала. Настройки
          целей — в Options.
        </p>
      </section>

      <div class="mt-4 flex flex-col gap-2">
        <button
          type="button"
          class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
          @click="openBoard"
        >
          Открыть доску ELCAS
        </button>
        <button
          type="button"
          class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          @click="openOptions"
        >
          Настройки
        </button>
      </div>
    </main>
  </div>
</template>
