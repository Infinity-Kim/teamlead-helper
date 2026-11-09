<script lang="ts" setup>
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import { ADS } from './ads-tokens';

/**
 * Значок «?» с подсказкой к метрике: заголовок и до 4 коротких абзацев (what, how, read, plan).
 * Показываются только заполненные: хватает одной строки - передайте только `what`.
 * Инлайн-стили (монтируется в light DOM Jira, scoped-CSS не доедет). Слой: components.
 *
 * Popover рендерится через Teleport в body с position: fixed по getBoundingClientRect значка:
 * так его не обрезает родитель с overflow (строка спринта, таблица, панель). Сторона раскрытия
 * задаётся `align`, у края окна popover сдвигается внутрь, при нехватке места снизу открывается
 * над значком, ширина не больше окна. Шрифт копируется с места значка: в body Jira и отчёта он
 * может быть другим. Доступность: role=button, tabindex, показ по focus, закрытие по Escape.
 */
const props = defineProps<{
  /** Заголовок метрики. */
  title: string;
  /** Что это и пример на числах - одна строка. */
  what: string;
  /** Как считаем, если не видно из `what`. */
  how?: string;
  /** Как читать значение. */
  read?: string;
  /** Что делать на планировании (выделяется цветом). */
  plan?: string;
  /** Сторона раскрытия относительно значка (по умолчанию вправо). */
  align?: 'left' | 'right';
}>();

const T = ADS;
/** Отступ popover от края окна и от значка, px. */
const EDGE = 8;
const GAP = 6;

const open = ref(false);
const anchor = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0, maxH: 0, ready: false });
const font = ref<string>('');
/** Ширина окна без полосы прокрутки: 100vw её включает, и popover уезжал бы под неё. */
const maxW = ref(0);
const alignRight = computed(() => (props.align ?? 'right') === 'right');
/** Абзацы подсказки без пустых: старые вызовы с 4 поясами и новые с 1 строкой рисуются одинаково. */
const lines = computed(() =>
  (
    [
      { text: props.what, color: T.text },
      { text: props.how, color: T.text },
      { text: props.read, color: T.text },
      { text: props.plan, color: T.information },
    ] as { text?: string; color: string }[]
  ).filter((l): l is { text: string; color: string } => !!l.text?.trim()),
);

let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** Ставит popover у значка и удерживает его целиком в окне. */
function place() {
  const a = anchor.value;
  const p = pop.value;
  if (!a || !p) return;
  const r = a.getBoundingClientRect();
  const w = p.offsetWidth;
  // Полная высота содержимого: offsetHeight уже урезан maxHeight после прошлой расстановки.
  const h = p.scrollHeight + (p.offsetHeight - p.clientHeight);
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;

  let left = alignRight.value ? r.left - EDGE : r.right + EDGE - w;
  left = Math.min(left, vw - EDGE - w);
  left = Math.max(left, EDGE);

  // Снизу, если влезает; иначе сверху; если не влезает нигде - туда, где места больше,
  // с прокруткой внутри. Значок popover не перекрывает, иначе он мигал бы под курсором.
  const below = vh - EDGE - (r.bottom + GAP);
  const above = r.top - GAP - EDGE;
  const up = h > below && (h <= above || above > below);
  const maxH = Math.max(80, up ? above : below);
  const top = up ? r.top - GAP - Math.min(h, maxH) : r.bottom + GAP;

  pos.value = { left, top, maxH, ready: true };
}

async function onViewportChange() {
  if (!open.value) return;
  const w = (document.documentElement.clientWidth || window.innerWidth) - EDGE * 2;
  if (w !== maxW.value) {
    maxW.value = w;
    await nextTick();
  }
  place();
}

function listen(on: boolean) {
  const m = on ? 'addEventListener' : 'removeEventListener';
  window[m]('scroll', onViewportChange, true);
  window[m]('resize', onViewportChange);
}

async function show() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (open.value) return;
  if (anchor.value) font.value = getComputedStyle(anchor.value).fontFamily;
  maxW.value = (document.documentElement.clientWidth || window.innerWidth) - EDGE * 2;
  pos.value = { left: 0, top: 0, maxH: 0, ready: false };
  open.value = true;
  listen(true);
  await nextTick();
  place();
}

function hide() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
  if (!open.value) return;
  open.value = false;
  listen(false);
}

/** Задержка, чтобы курсор успел перейти со значка на popover: он теперь не внутри значка. */
function hideSoon() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(hide, 120);
}

onBeforeUnmount(hide);
</script>

<template>
  <span
    ref="anchor"
    :style="{
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      verticalAlign: 'middle',
    }"
    @mouseenter="show"
    @mouseleave="hideSoon"
  >
    <span
      role="button"
      tabindex="0"
      :aria-label="`Подсказка: ${title}`"
      :style="{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        border: `1px solid ${T.subtlest}`,
        color: T.subtle,
        fontSize: '10px',
        fontWeight: 700,
        lineHeight: '1',
        cursor: 'help',
        userSelect: 'none',
        flex: '0 0 auto',
      }"
      @focus="show"
      @blur="hide"
      @keydown.escape="hide"
    >
      ?
    </span>

    <Teleport to="body">
      <div
        v-if="open"
        ref="pop"
        role="tooltip"
        :style="{
          position: 'fixed',
          left: `${pos.left}px`,
          top: `${pos.top}px`,
          visibility: pos.ready ? 'visible' : 'hidden',
          zIndex: '2147483000',
          boxSizing: 'border-box',
          width: '280px',
          maxWidth: maxW > 0 ? `${maxW}px` : `calc(100vw - ${EDGE * 2}px)`,
          maxHeight: pos.ready ? `${pos.maxH}px` : `calc(100vh - ${EDGE * 2}px)`,
          overflowY: 'auto',
          fontFamily: font || undefined,
          textAlign: 'left',
          padding: '10px 12px',
          background: 'var(--ds-surface-overlay, #fff)',
          color: T.text,
          border: `1px solid var(--ds-border, rgba(9,30,66,0.14))`,
          borderRadius: '6px',
          boxShadow: '0 4px 12px rgba(9,30,66,0.22), 0 0 1px rgba(9,30,66,0.31)',
          fontSize: '12px',
          lineHeight: '16px',
          fontWeight: '400',
          textTransform: 'none',
          letterSpacing: '0',
          cursor: 'default',
          whiteSpace: 'normal',
        }"
        @mouseenter="show"
        @mouseleave="hideSoon"
      >
        <div :style="{ fontWeight: 700, marginBottom: '4px' }">{{ title }}</div>
        <p
          v-for="(l, i) in lines"
          :key="i"
          :style="{ margin: i ? '4px 0 0' : '0', color: l.color }"
        >
          {{ l.text }}
        </p>
      </div>
    </Teleport>
  </span>
</template>
