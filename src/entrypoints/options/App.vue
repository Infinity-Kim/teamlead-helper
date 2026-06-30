<script lang="ts" setup>
import { ref, onMounted, computed } from 'vue';
import {
  capTargets,
  sprintHistoryCount,
  quarterTarget,
  quarterUiMode,
  type QuarterUiMode,
} from '@/shared/storage';
import type { CapTargets } from '@/core/domain';

const targets = ref<CapTargets>({ Product: 67, Tech: 16.5, Support: 16.5 });
const historyN = ref(6);
const qProduct = ref(67);
const qBand = ref(5);
const qMode = ref<QuarterUiMode>('topBoard');
const saved = ref(false);

const sum = computed(
  () => +(targets.value.Product + targets.value.Tech + targets.value.Support).toFixed(1),
);
const sumValid = computed(() => Math.abs(sum.value - 100) < 0.05);

const QUARTER_MODES: { value: QuarterUiMode; label: string }[] = [
  { value: 'topBoard', label: 'Блок вверху доски' },
  { value: 'perSprint', label: 'Над активным спринтом' },
  { value: 'off', label: 'Выключено' },
];

onMounted(async () => {
  targets.value = await capTargets.getValue();
  historyN.value = await sprintHistoryCount.getValue();
  const qt = await quarterTarget.getValue();
  qProduct.value = qt.productPct;
  qBand.value = qt.bandPp;
  qMode.value = await quarterUiMode.getValue();
});

async function save() {
  if (!sumValid.value) return;
  await capTargets.setValue(targets.value);
  await sprintHistoryCount.setValue(Math.max(1, Math.round(historyN.value)));
  await quarterTarget.setValue({ productPct: qProduct.value, bandPp: qBand.value });
  await quarterUiMode.setValue(qMode.value);
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}
</script>

<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <div class="mx-auto max-w-xl px-6 py-10">
      <header class="mb-8 flex items-center gap-3">
        <span
          class="grid size-9 place-items-center rounded-lg bg-indigo-600 text-base font-bold text-white"
        >
          TL
        </span>
        <div>
          <h1 class="text-lg font-semibold">Team Lead Helper</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">Настройки</p>
        </div>
      </header>

      <form
        class="space-y-5 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
        @submit.prevent="save"
      >
        <div>
          <h2 class="text-sm font-semibold">Целевое распределение capacity (%)</h2>
          <p class="mt-1 text-xs text-slate-400">Сумма должна равняться 100%.</p>
        </div>

        <div class="grid grid-cols-3 gap-3">
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-emerald-600">Product</span>
            <input
              v-model.number="targets.Product"
              type="number"
              step="0.5"
              min="0"
              max="100"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-sky-600">Tech</span>
            <input
              v-model.number="targets.Tech"
              type="number"
              step="0.5"
              min="0"
              max="100"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-amber-600">Support</span>
            <input
              v-model.number="targets.Support"
              type="number"
              step="0.5"
              min="0"
              max="100"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
        </div>
        <p class="text-xs" :class="sumValid ? 'text-slate-400' : 'text-red-500'">
          Сумма: {{ sum }}%<span v-if="!sumValid"> — должно быть 100%</span>
        </p>

        <label class="block border-t border-slate-200 pt-4 dark:border-slate-800">
          <span class="mb-1 block text-sm font-medium">Спринтов для медианы velocity</span>
          <input
            v-model.number="historyN"
            type="number"
            min="1"
            max="50"
            class="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
          />
          <span class="mt-1 block text-xs text-slate-400">
            Сколько последних закрытых спринтов брать для медианы выполненных SP (рекомендуемый
            предел на полосе).
          </span>
        </label>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="mb-2 text-sm font-semibold">Квартальный баланс</h2>
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="mb-1 block text-xs font-medium">Цель Product за квартал, %</span>
              <input
                v-model.number="qProduct"
                type="number"
                min="0"
                max="100"
                step="1"
                class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium">Коридор ±, пп</span>
              <input
                v-model.number="qBand"
                type="number"
                min="0"
                max="50"
                step="1"
                class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              />
            </label>
          </div>
          <span class="mt-1 block text-xs text-slate-400">
            Остальное (Tech+Support) = {{ 100 - qProduct }}%. Алерт при выходе накопленного за
            квартал за {{ qProduct - qBand }}–{{ qProduct + qBand }}%.
          </span>

          <label class="mt-3 block">
            <span class="mb-1 block text-xs font-medium">Где показывать квартальный баланс</span>
            <select
              v-model="qMode"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            >
              <option v-for="m in QUARTER_MODES" :key="m.value" :value="m.value">
                {{ m.label }}
              </option>
            </select>
            <span class="mt-1 block text-xs text-slate-400">
              Переключай и смотри на доске/в панели, какой вариант удобнее.
            </span>
          </label>
        </div>

        <p class="border-t border-slate-200 pt-4 text-xs text-slate-400 dark:border-slate-800">
          Виджет работает на любой доске автоматически — настройки применяются ко всем.
        </p>

        <div class="flex items-center gap-3 pt-1">
          <button
            type="submit"
            :disabled="!sumValid"
            class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            Сохранить
          </button>
          <span v-if="saved" class="text-sm text-green-600">Сохранено ✓</span>
        </div>
      </form>
    </div>
  </div>
</template>
