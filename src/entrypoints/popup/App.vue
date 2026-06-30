<script lang="ts" setup>
import { ref } from 'vue';
import { browser } from 'wxt/browser';

const opening = ref(false);

/** Открыть side panel в текущем окне. */
async function openSidePanel() {
  opening.value = true;
  try {
    const win = await browser.windows.getCurrent();
    if (win.id != null) {
      await browser.sidePanel.open({ windowId: win.id });
      window.close();
    }
  } finally {
    opening.value = false;
  }
}

function openOptions() {
  browser.runtime.openOptionsPage();
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
      Помощник тимлида. Подсчёты и аналитика по Jira.
    </p>

    <div class="flex flex-col gap-2">
      <button
        type="button"
        :disabled="opening"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
        @click="openSidePanel"
      >
        Открыть панель
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
</template>
