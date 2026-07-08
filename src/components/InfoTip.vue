<script lang="ts" setup>
import { ref, computed } from 'vue';
import { ADS } from './ads-tokens';

/**
 * Значок «?» с богатым тултипом-объяснением метрики. При наведении/фокусе показывает popover:
 * что это · как считается (формула) · как читать · чем поможет на планировании.
 * Инлайн-стили (монтируется в light DOM Jira, scoped-CSS не доедет). Слой: components.
 *
 * Позиционируется абсолютно относительно значка; сторона (влево/вправо) задаётся `align`,
 * чтобы popover не уезжал за край доски. Доступность: role=button, tabindex, показ по focus.
 */
const props = defineProps<{
  /** Заголовок метрики. */
  title: string;
  /** Что это — одна фраза. */
  what: string;
  /** Как считается (формула/правило). */
  how: string;
  /** Как читать значение. */
  read: string;
  /** Чем поможет на планировании. */
  plan: string;
  /** Сторона раскрытия относительно значка (по умолчанию вправо). */
  align?: 'left' | 'right';
}>();

const T = ADS;
const open = ref(false);
const alignRight = computed(() => (props.align ?? 'right') === 'right');
</script>

<template>
  <span
    :style="{
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      verticalAlign: 'middle',
    }"
    @mouseenter="open = true"
    @mouseleave="open = false"
  >
    <span
      role="button"
      tabindex="0"
      :aria-label="`Как считается: ${title}`"
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
      @focus="open = true"
      @blur="open = false"
      @keydown.escape="open = false"
    >
      ?
    </span>

    <div
      v-if="open"
      :style="{
        position: 'absolute',
        top: '20px',
        [alignRight ? 'left' : 'right']: '-8px',
        zIndex: '2147483000',
        width: '280px',
        maxWidth: '80vw',
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
    >
      <div :style="{ fontWeight: 700, marginBottom: '5px', fontSize: '12px' }">{{ title }}</div>
      <div :style="{ marginBottom: '6px', color: T.subtle }">{{ what }}</div>
      <div :style="{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }">
        <span :style="{ color: T.subtlest, fontWeight: 600 }">Формула</span>
        <span>{{ how }}</span>
        <span :style="{ color: T.subtlest, fontWeight: 600 }">Как читать</span>
        <span>{{ read }}</span>
        <span :style="{ color: T.subtlest, fontWeight: 600 }">На планировании</span>
        <span :style="{ color: T.information }">{{ plan }}</span>
      </div>
    </div>
  </span>
</template>
