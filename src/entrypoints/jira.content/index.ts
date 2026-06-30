import { createApp, reactive, h, type App as VueApp } from 'vue';
import CapBar from '@/components/CapBar.vue';
import QuarterBar from '@/components/QuarterBar.vue';
import { getBoardBacklog, getSprintVelocities, getQuarterSprints } from '@/api/jira';
import {
  issuesOfSprint,
  calcCapDistribution,
  issueKeysByBucket,
  median,
  quarterOf,
  groupByQuarter,
  calcQuarterBalance,
} from '@/core/metrics';
import {
  capTargets,
  boardConfig,
  sprintHistoryCount,
  quarterTarget,
  quarterUiMode,
} from '@/shared/storage';
import { BUCKET_TO_CAP_LABEL, ALL_CAP_LABELS, bucketForLabel } from '@/core/domain';
import type {
  BoardBacklog,
  CapBucket,
  CapTargets,
  CapSlice,
  SprintCapStats,
  QuarterBalance,
} from '@/core/domain';

/**
 * Content script на backlog ЛЮБОЙ Jira-доски (ELCAS/80, PL/1178, WEB/16, …). Под заголовком
 * каждого спринта — stacked-bar с распределением SP по CAP-бакетам, целевым маркером и
 * кликабельной легендой (фильтр). rapidViewId берётся из URL — доска не зашита.
 *
 * Real-time: после правки лейбла/оценки Jira перерисовывает доску → MutationObserver ловит
 * это, дебаунсит и перезапрашивает backlog/data; перерисовываем только если изменился отпечаток.
 * Плюс кнопка ↻ для немедленного рефетча. Защиты: троттл, игнор собственных мутаций, сохранение фильтра.
 *
 * Архитектура: тонкий корень композиции. Данные — api/jira (сессия браузера), расчёт —
 * чистые функции core/metrics. Здесь wiring + DOM-монтаж + DOM-фильтрация.
 */

const CONTAINER_PREFIX = 'software-backlog.card-list.container.';
const CONTAINER_SEL = `[data-testid^="${CONTAINER_PREFIX}"]`;
const CARD_PREFIX = 'software-backlog.card-list.card.content-container.';
const CARD_SEL = `[data-testid^="${CARD_PREFIX}"]`;
const HEADER_SEL = '[data-testid*="sprint-header"]';
const MOUNTED_ATTR = 'data-tlh-capbar';
const QUARTER_ATTR = 'data-tlh-quarter'; // блок квартальной сводки вверху доски
// Атрибут-маркер подсвеченной Unlabeled-карточки (через него же снимаем подсветку).
const UNLABELED_HL_ATTR = 'data-tlh-unlabeled';
const REFETCH_DEBOUNCE_MS = 2500;

interface CapBarProps {
  stats: SprintCapStats;
  targetProductPct: number;
  activeBuckets: CapSlice[];
  medianSp: number | null;
  refreshing: boolean;
}
interface Mounted {
  app: VueApp;
  props: CapBarProps;
  sprintId: number;
  container: HTMLElement;
}

export default defineContentScript({
  matches: ['*://*.atlassian.net/*'],
  runAt: 'document_idle',

  async main(ctx) {
    const mark = (stage: string) => {
      document.documentElement.dataset.tlhStage = stage;
    };
    mark('main-start');

    const isBacklog = () => /\/boards\/\d+\/backlog/.test(location.pathname);

    /** rapidViewId текущей доски из URL (/boards/<ID>/backlog). null — не на backlog-доске. */
    function rapidViewIdFromUrl(): number | null {
      const m = location.pathname.match(/\/boards\/(\d+)\/backlog/);
      return m ? Number(m[1]) : null;
    }

    /**
     * Активная доска: приоритет — из URL (универсально), фоллбэк — ручной override boardConfig
     * (используется, только если в URL доску определить не удалось). Единый источник для всех загрузок.
     */
    async function resolveRapidViewId(): Promise<number> {
      return rapidViewIdFromUrl() ?? (await boardConfig.getValue()).rapidViewId;
    }

    let targets: CapTargets = await capTargets.getValue();
    const statsBySprintId = new Map<number, SprintCapStats>();
    const mounted = new Map<HTMLElement, Mounted>();

    let refreshing = false;
    let dataFingerprint = '';
    // Доска, для которой сейчас загружены данные (для детекта смены доски в SPA).
    let currentBoardId: number | null = null;
    // Ключи задач без CAP-метки — для подсветки Unlabeled на доске.
    let unlabeledKeys = new Set<string>();
    // Медиана completed SP за последние N спринтов (рекомендуемый capacity). null — нет данных.
    let medianSp: number | null = null;
    // Квартальный баланс текущего квартала (того, где активный спринт). null — нет данных.
    let quarterBalance: QuarterBalance | null = null;
    let quarterApp: VueApp | null = null;
    let quarterHost: HTMLElement | null = null;
    // Reactive-props QuarterBar — обновляем на месте вместо remount приложения на каждом кадре.
    let quarterProps: {
      balance: QuarterBalance;
      targetPct: number;
      bandPp: number;
    } | null = null;

    /** Отпечаток данных — чтобы не перерисовывать, если ничего по сути не изменилось. */
    function fingerprint(backlog: BoardBacklog): string {
      const parts: string[] = [];
      for (const i of backlog.issues) {
        if (i.hierarchyLevel !== 0) continue;
        parts.push(`${i.key}:${i.storyPoints}:${i.capBuckets.join(',')}:${i.sprintIds.join('.')}`);
      }
      return parts.sort().join('|');
    }

    /** Загрузить и пересчитать. Возвращает true, если данные изменились (отпечаток другой). */
    async function loadData(): Promise<boolean> {
      const rapidViewId = await resolveRapidViewId();
      currentBoardId = rapidViewId;
      const backlog: BoardBacklog = await getBoardBacklog(rapidViewId);
      targets = await capTargets.getValue();

      const fp = fingerprint(backlog);
      const changed = fp !== dataFingerprint;
      dataFingerprint = fp;

      const topLevel = backlog.issues.filter((i) => i.hierarchyLevel === 0);
      unlabeledKeys = new Set(issueKeysByBucket(topLevel).Unlabeled);

      statsBySprintId.clear();
      for (const sprint of backlog.sprints) {
        const sprintIssues = issuesOfSprint(backlog.issues, sprint.id);
        statsBySprintId.set(sprint.id, calcCapDistribution(sprint, sprintIssues, targets));
      }
      return changed;
    }

    /**
     * Загрузить медиану velocity (отдельно от backlog — это N+1 запросов, не гоняем на каждом рефетче).
     * Вызывается один раз при старте + при смене доски/настройки N.
     */
    async function loadMedian() {
      try {
        const rapidViewId = await resolveRapidViewId();
        const n = await sprintHistoryCount.getValue();
        const velocities = await getSprintVelocities(rapidViewId, n);
        medianSp = median(velocities);
        for (const m of mounted.values()) m.props.medianSp = medianSp;
      } catch (e) {
        console.warn('[TLH] loadMedian failed:', e);
      }
    }

    /**
     * Загрузить квартальный баланс (того квартала, где активный спринт). N+1 запросов — фоном.
     * Спринты относим к кварталу по ДАТЕ СТАРТА (методология). Считаем по completed-задачам.
     */
    async function loadQuarter() {
      try {
        const rapidViewId = await resolveRapidViewId();
        // Берём с запасом (10) — покрыть текущий квартал (6) + границу.
        const records = await getQuarterSprints(rapidViewId, 10);
        const target = await quarterTarget.getValue();

        // Текущий квартал = квартал активного спринта (или самого свежего по старту).
        const active = records.find((r) => r.state === 'ACTIVE') ?? records[0];
        const curQuarter = active ? quarterOf(active.startDate) : null;
        if (!curQuarter) {
          quarterBalance = null;
        } else {
          const byQ = groupByQuarter(records);
          const sprints = byQ.get(curQuarter) ?? [];
          quarterBalance = calcQuarterBalance(curQuarter, sprints, {
            productPct: target.productPct,
            bandPp: target.bandPp,
          });
        }
        renderQuarterBlock();
      } catch (e) {
        console.warn('[TLH] loadQuarter failed:', e);
      }
    }

    /** Смонтировать/обновить блок квартальной сводки вверху доски (режим topBoard). */
    async function renderQuarterBlock() {
      const mode = await quarterUiMode.getValue();
      const target = await quarterTarget.getValue();

      // На доске блок показываем в режимах topBoard и perSprint. sidePanel/off — убираем.
      const onBoard = mode === 'topBoard' || mode === 'perSprint';
      if (!onBoard || !quarterBalance) {
        quarterApp?.unmount();
        quarterApp = null;
        quarterHost?.remove();
        quarterHost = null;
        quarterProps = null;
        return;
      }

      const firstContainer = document.querySelector<HTMLElement>(CONTAINER_SEL);
      if (!firstContainer?.parentElement) return;

      // topBoard — НАД всем списком спринтов; perSprint — ВНУТРИ контейнера активного спринта
      // (после строки заголовка), чтобы блок визуально принадлежал текущему спринту.
      let anchorParent: HTMLElement;
      let anchorNext: Node | null;
      if (mode === 'perSprint') {
        const header = firstContainer.querySelector(HEADER_SEL);
        const headerChild =
          header && Array.from(firstContainer.children).find((c) => c.contains(header));
        anchorParent = firstContainer;
        anchorNext = headerChild?.nextSibling ?? firstContainer.firstChild;
      } else {
        anchorParent = firstContainer.parentElement;
        anchorNext = firstContainer;
      }

      // Свежие props в reactive-объект — Vue перерисует на месте, без пересоздания приложения
      // (renderQuarterBlock зовётся на каждом кадре скролла — remount был бы дорог).
      if (!quarterProps) {
        quarterProps = reactive({
          balance: quarterBalance,
          targetPct: target.productPct,
          bandPp: target.bandPp,
        });
      } else {
        quarterProps.balance = quarterBalance;
        quarterProps.targetPct = target.productPct;
        quarterProps.bandPp = target.bandPp;
      }

      // Хост пересоздаём, только если потерялся/переехал; вместе с ним — Vue-приложение.
      if (!quarterHost || !quarterHost.isConnected || quarterHost.parentElement !== anchorParent) {
        quarterApp?.unmount();
        quarterApp = null;
        quarterHost?.remove();
        quarterHost = document.createElement('div');
        quarterHost.setAttribute(QUARTER_ATTR, mode);
        Object.assign(quarterHost.style, {
          padding: mode === 'perSprint' ? '6px 8px 8px' : '8px 8px 10px',
          margin: '0 0 4px',
          borderBottom:
            mode === 'topBoard' ? '1px solid var(--ds-border, rgba(11,18,14,0.14))' : 'none',
          background: mode === 'perSprint' ? 'var(--ds-surface-sunken, rgba(9,30,66,0.03))' : '',
          borderRadius: mode === 'perSprint' ? '4px' : '0',
        });
        anchorParent.insertBefore(quarterHost, anchorNext);
      }
      if (!quarterApp) {
        const p = quarterProps;
        quarterApp = createApp({
          render: () =>
            h(QuarterBar, { balance: p.balance, targetPct: p.targetPct, bandPp: p.bandPp }),
        });
        quarterApp.mount(quarterHost);
      }
    }

    function sprintIdOf(container: HTMLElement): number | null {
      const id = Number(
        (container.getAttribute('data-testid') ?? '').slice(CONTAINER_PREFIX.length),
      );
      return Number.isFinite(id) ? id : null;
    }

    // --- Фильтр через РОДНОЙ механизм Jira (?label=CAP_X) ---
    // Бакет ↔ Jira-лейбл берём из канона домена (BUCKET_TO_CAP_LABEL/ALL_CAP_LABELS/bucketForLabel),
    // не держим вторую копию. Unlabeled не имеет своей метки → клик по нему трактуется как сброс.

    /** Активные бакеты из URL Jira (?label=CAP_A,CAP_B). Мультивыбор — общий фильтр доски. */
    function activeBucketsFromUrl(): CapBucket[] {
      const raw = new URLSearchParams(location.search).get('label') ?? '';
      return raw
        .split(',')
        .map((l) => bucketForLabel(l.trim()))
        .filter((b): b is CapBucket => !!b);
    }

    /**
     * Найти кнопку-триггер родного фильтра «Метка».
     * Стабильный путь — по data-testid `filters.common.ui.list.<...>-filter`: среди них берём ту,
     * чей текст совпадает с «Метка/Label/...» (testid локализован, поэтому матчим текстом по списку).
     */
    function findLabelFilterButton(): HTMLElement | null {
      const re = /^(метк|label|etiket|tag|метка)/i;
      const listFilters = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="filters.common.ui.list."]'),
      ).filter((el) => /-filter$/.test(el.getAttribute('data-testid') ?? ''));
      return (
        listFilters.find((el) => re.test((el.textContent ?? '').trim())) ??
        // запасной поиск — любая кнопка с подходящим текстом
        Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"],span')).find(
          (b) => re.test((b.textContent ?? '').trim()),
        ) ??
        null
      );
    }

    /** Открыть дропдаун фильтра меток и дождаться появления опций. */
    async function openLabelDropdown(): Promise<boolean> {
      const btn = findLabelFilterButton();
      if (!btn) return false;
      // Если опции уже видны — дропдаун открыт.
      if (document.querySelector('[role="option"]')) return true;
      btn.click();
      const opt = await waitFor(() => document.querySelector('[role="option"]') ?? undefined);
      return !!opt;
    }

    /** Закрыть дропдаун (react-select остаётся открытым после клика по опции). */
    function closeDropdown() {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // Клик по нейтральной зоне, если Escape не закрыл.
      (document.querySelector('main') ?? document.body).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    }

    /** Fallback: навигация (перезагрузка) — только если UI совсем недоступен. */
    function navigateLabels(labels: string[]) {
      const url = new URL(location.href);
      if (labels.length) url.searchParams.set('label', labels.join(','));
      else url.searchParams.delete('label');
      location.assign(url.toString());
    }

    /** CAP-метка опции дропдауна (текст выбранной дублируется «CAP_TechCAP_Tech» → ищем по includes). */
    function optionCapLabel(o: HTMLElement): string | null {
      const txt = (o.textContent ?? '').trim();
      return ALL_CAP_LABELS.find((l) => txt.includes(l)) ?? null;
    }

    /**
     * Синхронизировать родной фильтр Jira к НАБОРУ CAP-меток — без перезагрузки (SPA, мультивыбор).
     * Открываем дропдаун и приводим выбор опций к целевому набору: снимаем лишние CAP-метки,
     * добавляем недостающие (клик по опции тогглит её aria-selected). Fallback — навигация.
     */
    async function syncLabelFilter(targetBuckets: Set<CapBucket>) {
      const targetLabels = new Set([...targetBuckets].map((b) => BUCKET_TO_CAP_LABEL[b]));

      const opened = await openLabelDropdown();
      if (!opened) {
        navigateLabels([...targetLabels]); // UI недоступен — fallback с перезагрузкой
        return;
      }

      // Несколько проходов: после каждого клика список перерисовывается (опции меняют позицию).
      for (let pass = 0; pass < ALL_CAP_LABELS.length + 1; pass++) {
        const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
        // найти первую CAP-опцию, чьё состояние расходится с целью
        const mismatch = options.find((o) => {
          const label = optionCapLabel(o);
          if (!label) return false;
          const selected = o.getAttribute('aria-selected') === 'true';
          const want = targetLabels.has(label);
          return selected !== want;
        });
        if (!mismatch) break; // всё совпало
        mismatch.click();
        await waitFor(() => true, 250); // дать перерисоваться
      }
      closeDropdown();
    }

    /** Дождаться ненулевого результата fn (poll ~50мс до timeout). */
    function waitFor<T>(fn: () => T | undefined, timeoutMs = 1500): Promise<T | null> {
      return new Promise((resolve) => {
        const started = performance.now();
        const tick = () => {
          const v = fn();
          if (v) return resolve(v);
          if (performance.now() - started > timeoutMs) return resolve(null);
          setTimeout(tick, 50);
        };
        tick();
      });
    }

    // Оптимистичная подсветка: после клика URL Jira обновляется не сразу (~300мс). Чтобы выделение
    // не мелькало, держим `pendingBuckets` приоритетом над URL, пока URL не подтвердит набор.
    let pendingBuckets: CapBucket[] | null = null;
    // Активна ли Unlabeled-подсветка (карточки без CAP-метки выделяются прямо на доске).
    let unlabeledActive = false;
    // Есть ли сейчас на доске декорированные карточки — чтобы applyUnlabeledHighlight
    // (зовётся на каждом кадре скролла из renderAll) не сканировал весь DOM впустую,
    // когда подсветка выключена и снимать уже нечего.
    let unlabeledDecorated = false;

    /** Активный набор срезов для подсветки чипов: CAP-набор из URL ИЛИ [Unlabeled]. */
    function activeSlices(): CapSlice[] {
      if (unlabeledActive) return ['Unlabeled'];
      return pendingBuckets ?? activeBucketsFromUrl();
    }

    const sameSet = (a: CapBucket[], b: CapBucket[]) =>
      a.length === b.length && a.every((x) => b.includes(x));

    /** Применить подсветку чипов (набор) во всех виджетах. */
    function applyHighlight(active: CapSlice[]) {
      for (const m of mounted.values()) {
        const cur = m.props.activeBuckets;
        if (cur.length !== active.length || !active.every((x) => cur.includes(x))) {
          m.props.activeBuckets = active;
        }
      }
    }

    /**
     * Синхронизировать подсветку. Пока ждём подтверждения (pendingBuckets) — держим оптимистичное,
     * пока URL не подтвердит набор; иначе промежуточные мутации перетрут подсветку → мелькание.
     */
    function syncActiveFromUrl() {
      if (pendingBuckets) {
        if (sameSet(activeBucketsFromUrl(), pendingBuckets)) pendingBuckets = null;
      }
      applyHighlight(activeSlices());
    }

    /** Ключ задачи из data-testid карточки. */
    function cardKeyOf(card: HTMLElement): string | null {
      const t = card.getAttribute('data-testid') ?? '';
      return t.startsWith(CARD_PREFIX) ? t.slice(CARD_PREFIX.length) : null;
    }

    /**
     * Подсветить на доске карточки без CAP-метки (Unlabeled) — ЯВНО: толстая цветная рамка,
     * полупрозрачный фон и бейдж «без метки». НЕ скрываем остальные (надёжно при виртуализации).
     * Переприменяется при скролле.
     */
    const UNLABELED_COLOR = 'var(--ds-background-information-bold, #1868db)';
    function decorateUnlabeled(card: HTMLElement) {
      card.setAttribute(UNLABELED_HL_ATTR, '');
      card.style.outline = `2px solid ${UNLABELED_COLOR}`;
      card.style.outlineOffset = '-2px';
      card.style.borderRadius = '4px';
      card.style.boxShadow = `inset 4px 0 0 0 ${UNLABELED_COLOR}`;
      card.style.background = 'var(--ds-background-information, #e9f2fe)';
      if (!card.querySelector('.tlh-unlabeled-badge')) {
        const badge = document.createElement('span');
        badge.className = 'tlh-unlabeled-badge';
        badge.textContent = 'без CAP-метки';
        Object.assign(badge.style, {
          position: 'absolute',
          top: '2px',
          right: '4px',
          zIndex: '5',
          padding: '0 6px',
          height: '16px',
          lineHeight: '16px',
          fontSize: '10px',
          fontWeight: '700',
          color: '#fff',
          background: UNLABELED_COLOR,
          borderRadius: '8px',
          fontFamily: 'var(--ds-font-family-body, sans-serif)',
          pointerEvents: 'none',
        } satisfies Partial<CSSStyleDeclaration>);
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
        card.appendChild(badge);
      }
    }
    function undecorateUnlabeled(card: HTMLElement) {
      card.removeAttribute(UNLABELED_HL_ATTR);
      card.style.outline = '';
      card.style.outlineOffset = '';
      card.style.borderRadius = '';
      card.style.boxShadow = '';
      card.style.background = '';
      card.querySelector('.tlh-unlabeled-badge')?.remove();
    }
    function applyUnlabeledHighlight() {
      // Подсветка выключена и на доске ничего не декорировано → сканировать DOM незачем
      // (горячий путь: renderAll зовёт это на каждом кадре скролла).
      if (!unlabeledActive && !unlabeledDecorated) return;
      let decorated = false;
      document.querySelectorAll<HTMLElement>(CARD_SEL).forEach((card) => {
        const key = cardKeyOf(card);
        const wantHl = unlabeledActive && key !== null && unlabeledKeys.has(key);
        const has = card.hasAttribute(UNLABELED_HL_ATTR);
        if (wantHl && !has) decorateUnlabeled(card);
        else if (!wantHl && has) undecorateUnlabeled(card);
        if (wantHl) decorated = true;
      });
      unlabeledDecorated = decorated;
    }

    /** Снять Unlabeled-подсветку (если активна) и убрать её с карточек доски. */
    function clearUnlabeled() {
      if (!unlabeledActive) return;
      unlabeledActive = false;
      applyUnlabeledHighlight();
    }

    /** Применить целевой CAP-набор: оптимистичная подсветка + синхронизация фильтра Jira. */
    function applyCapSet(next: CapBucket[]) {
      pendingBuckets = next;
      applyHighlight(next);
      // Страховка: снять pending по таймауту, даже если URL не подтвердился (fallback и т.п.).
      setTimeout(() => {
        pendingBuckets = null;
        syncActiveFromUrl();
      }, 2000);
      void syncLabelFilter(new Set(next));
    }

    function onBucketClick(_sprintId: number, bucket: CapSlice) {
      if (bucket === 'Unlabeled') {
        // Тоггл подсветки Unlabeled. CAP-фильтр снимаем (взаимоисключение).
        unlabeledActive = !unlabeledActive;
        if (unlabeledActive && activeBucketsFromUrl().length > 0) applyCapSet([]);
        applyHighlight(activeSlices());
        applyUnlabeledHighlight();
        return;
      }

      // CAP-бакет → тоггл в наборе. Снимаем Unlabeled (взаимоисключение).
      clearUnlabeled();
      const current = pendingBuckets ?? activeBucketsFromUrl();
      const next = current.includes(bucket)
        ? current.filter((b) => b !== bucket)
        : [...current, bucket];
      applyCapSet(next);
    }

    function onClearAll() {
      clearUnlabeled();
      applyCapSet([]);
    }

    function setRefreshing(v: boolean) {
      refreshing = v;
      for (const m of mounted.values()) m.props.refreshing = v;
    }

    /** Рефетч + перерисовка (если данные изменились). Сохраняет активные фильтры по спринтам. */
    async function refresh() {
      if (refreshing) return;
      setRefreshing(true);
      try {
        const changed = await loadData();
        if (changed) {
          for (const m of mounted.values()) {
            const stats = statsBySprintId.get(m.sprintId);
            if (stats) m.props.stats = stats;
            m.props.targetProductPct = targets.Product;
          }
        }
        syncActiveFromUrl();
      } catch (e) {
        console.warn('[TLH] refresh failed:', e);
      } finally {
        setRefreshing(false);
      }
    }

    function mountReactive(
      host: HTMLElement,
      container: HTMLElement,
      sprintId: number,
      stats: SprintCapStats,
    ) {
      const props = reactive<CapBarProps>({
        stats,
        targetProductPct: targets.Product,
        activeBuckets: activeSlices(),
        medianSp,
        refreshing,
      });
      const app = createApp({
        render: () =>
          h(CapBar, {
            stats: props.stats,
            targetProductPct: props.targetProductPct,
            activeBuckets: props.activeBuckets,
            medianSp: props.medianSp,
            refreshing: props.refreshing,
            onBucketClick: (b: CapSlice) => onBucketClick(sprintId, b),
            onClearAll,
            onRefresh: () => void refresh(),
          }),
      });
      app.mount(host);
      const entry: Mounted = { app, props, sprintId, container };
      mounted.set(host, entry);
    }

    function renderForContainer(container: HTMLElement) {
      const sprintId = sprintIdOf(container);
      if (sprintId === null) return;
      const stats = statsBySprintId.get(sprintId);
      if (!stats) return;

      // Уже смонтировано где-то внутри контейнера? — обновим props + контейнер (мог пересоздаться).
      const existing = container.querySelector<HTMLElement>(`:scope > [${MOUNTED_ATTR}]`);
      if (existing) {
        const m = mounted.get(existing);
        if (m) {
          m.props.stats = stats;
          m.props.targetProductPct = targets.Product;
          // activeBucket выставит syncActiveFromUrl() в конце renderAll (учитывает pending/Unlabeled).
          m.container = container;
        }
        return;
      }

      const host = document.createElement('div');
      host.setAttribute(MOUNTED_ATTR, String(sprintId));
      host.style.width = '100%';
      // Вставляем ПОСЛЕ строки заголовка спринта (во всю ширину, как сводка спринта).
      const header = container.querySelector(HEADER_SEL);
      const headerTopChild =
        header && Array.from(container.children).find((c) => c.contains(header));
      if (headerTopChild && headerTopChild.nextSibling) {
        container.insertBefore(host, headerTopChild.nextSibling);
      } else if (headerTopChild) {
        container.appendChild(host);
      } else {
        container.insertBefore(host, container.firstChild);
      }
      mountReactive(host, container, sprintId, stats);
    }

    function renderAll() {
      if (!isBacklog() || statsBySprintId.size === 0) return;
      document.querySelectorAll<HTMLElement>(CONTAINER_SEL).forEach(renderForContainer);
      syncActiveFromUrl();
      applyUnlabeledHighlight(); // переприменяем после скролл-ре-рендера карточек
      if (quarterBalance) void renderQuarterBlock(); // блок квартала мог потерять хост при ре-рендере
    }

    /** Сброс при переходе на другую доску (SPA-навигация): размонтируем виджеты, чистим кэш. */
    function resetForBoardChange() {
      mounted.forEach((m) => m.app.unmount());
      mounted.clear();
      statsBySprintId.clear();
      dataFingerprint = '';
      unlabeledActive = false;
      unlabeledDecorated = false;
      quarterBalance = null;
      quarterApp?.unmount();
      quarterApp = null;
      quarterHost?.remove();
      quarterHost = null;
      quarterProps = null;
    }

    try {
      mark('loading');
      await loadData();
      mark(`loaded:${statsBySprintId.size}`);
      renderAll();
      mark('rendered');
      void loadMedian(); // медиана грузится фоном (N+1 запросов) — не блокирует основной рендер
      void loadQuarter(); // квартальный баланс — тоже фоном
    } catch (e) {
      mark('error:' + (e instanceof Error ? e.message : String(e)));
      console.warn('[TLH] не удалось загрузить backlog:', e);
    }

    // Jira — SPA: контейнеры/карточки появляются и перерисовываются асинхронно (в т.ч. при скролле
    // список виртуализируется → поток мутаций). Чтобы не лагать, обрабатываем экономно:
    //  - быстрый pre-filter: реагируем ТОЛЬКО на мутации backlog-структуры (card-list), не на чужой DOM;
    //  - рендер коалесим в один кадр (rAF);
    //  - рефетч данных дебаунсим (2.5с).
    let rafRender = 0;
    let rafScheduled = false;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;

    /** Затрагивает ли мутация структуру backlog (контейнеры/карточки), а не наш виджет/чужой DOM. */
    function isBacklogMutation(m: MutationRecord): boolean {
      const t = m.target as HTMLElement;
      if (t.closest?.(`[${MOUNTED_ATTR}]`)) return false; // наш виджет — петля
      const touches = (n: Node) =>
        n instanceof HTMLElement &&
        (n.matches?.('[data-testid*="card-list"]') ||
          !!n.querySelector?.('[data-testid*="card-list"]'));
      for (const n of m.addedNodes) if (touches(n)) return true;
      for (const n of m.removedNodes) if (touches(n)) return true;
      return !!t.closest?.('[data-testid*="card-list"]');
    }

    const observer = new MutationObserver((mutations) => {
      if (!mutations.some(isBacklogMutation)) return;

      // Смена доски (SPA-навигация между /boards/<X> и /boards/<Y>) — сброс и перезагрузка.
      const urlBoard = rapidViewIdFromUrl();
      if (urlBoard !== null && urlBoard !== currentBoardId) {
        resetForBoardChange();
        medianSp = null;
        void loadData()
          .then(renderAll)
          .then(loadMedian)
          .then(loadQuarter)
          .catch(() => {});
        return;
      }

      // Рендер (до-монтаж новых виджетов + переприменение фильтров) — один раз за кадр.
      if (!rafScheduled) {
        rafScheduled = true;
        rafRender = requestAnimationFrame(() => {
          rafScheduled = false;
          renderAll();
        });
      }

      // Дебаунснутый рефетч: возможно, изменились данные (правка лейбла/оценки).
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(() => void refresh(), REFETCH_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    ctx.onInvalidated(() => {
      observer.disconnect();
      if (refetchTimer) clearTimeout(refetchTimer);
      cancelAnimationFrame(rafRender);
      // Снять Unlabeled-подсветку с карточек, чтобы не осталась после выгрузки.
      clearUnlabeled();
      mounted.forEach((m) => m.app.unmount());
      quarterApp?.unmount();
      quarterHost?.remove();
    });

    capTargets.watch(() => void refresh());
    boardConfig.watch(() => {
      dataFingerprint = ''; // другая доска — форсим перерисовку
      void refresh().then(renderAll);
      void loadMedian();
      void loadQuarter();
    });
    // Изменили N (сколько спринтов в медиану) — пересчитать медиану.
    sprintHistoryCount.watch(() => void loadMedian());
    // Квартальная цель / режим UI — перезагрузить квартальный баланс.
    quarterTarget.watch(() => void loadQuarter());
    quarterUiMode.watch(() => void loadQuarter());

    // Смена доски в SPA тоже перезагружает медиану/квартал (через resetForBoardChange + loadData).
  },
});
