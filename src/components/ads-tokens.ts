import type { CapSlice } from '@/core/domain';

/**
 * Общие ADS-токены Atlassian Design System (var(--ds-*), снятые с реального инстанса Jira)
 * для виджетов CapBar/QuarterBar. CSS-переменные → виджеты подхватывают тему Jira (light/dark);
 * hex-fallback страхует. Один источник истины — чтобы цвета/шрифты не расходились между виджетами.
 */
export const ADS = {
  fontFamily:
    'var(--ds-font-family-body, "Atlassian Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, "Helvetica Neue", sans-serif)',
  text: 'var(--ds-text, #292a2e)',
  subtle: 'var(--ds-text-subtle, #505258)',
  subtlest: 'var(--ds-text-subtlest, #6b6e76)',
  danger: 'var(--ds-text-danger, #ae2e24)',
  success: 'var(--ds-text-success, #4c6b1f)',
  information: 'var(--ds-text-information, #1558bc)',
  track: 'var(--ds-background-neutral, rgba(5,21,36,0.06))',
  hovered: 'var(--ds-background-neutral-subtle-hovered, rgba(5,21,36,0.06))',
  selected: 'var(--ds-background-selected, #e9f2fe)',
  selectedText: 'var(--ds-text-selected, #1558bc)',
  productColor: 'var(--ds-background-success-bold, #5b7f24)',
  otherColor: 'var(--ds-background-neutral-bold, #8590a2)',
} as const;

/** Цвета бакетов на стек-полосе (тот же ADS-палитр). */
export const BUCKET_COLORS: Record<CapSlice, string> = {
  Product: 'var(--ds-background-success-bold, #5b7f24)',
  Tech: 'var(--ds-background-information-bold, #1868db)',
  Support: 'var(--ds-background-warning-bold, #fbc828)',
  Unlabeled: 'var(--ds-background-neutral-bold, #8590a2)',
};
