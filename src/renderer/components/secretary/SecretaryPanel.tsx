import type { SecretaryScheduleView } from '@shared/types/secretary';
import {
  ArrowLeft,
  CalendarClock,
  ChevronRight,
  History,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Settings,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsSection } from '@/components/settings/kit';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { openSecretarySettings } from '@/lib/secretarySettingsLink';
import { secretaryIdOfProject, useSecretaryStore } from '@/stores/secretary';
import { SecretaryAvatar } from './SecretaryAvatar';
import { SecretaryContactPanel } from './SecretaryContactPanel';
import { SecretaryDailyBoard } from './SecretaryDailyBoard';
import { SecretaryMemoryPanel } from './SecretaryMemoryPanel';
import { SecretarySchedulePanel } from './SecretarySchedulePanel';
import { SecretarySkillsPanel } from './SecretarySkillsPanel';
import { SecretaryWorkbench } from './SecretaryWorkbench';
import { secretaryDigest } from './secretaryDigest';
import { SecretarySummary, secretarySectionView } from './secretaryView';

type Tab = 'workbench' | 'daily' | 'memory' | 'schedules' | 'contact' | 'skills';

const SECONDARY_VIEWS: {
  key: Exclude<Tab, 'workbench'>;
  label: string;
  icon: typeof LayoutGrid;
}[] = [
  { key: 'daily', label: 'Daily board', icon: LayoutGrid },
  { key: 'schedules', label: 'Schedules', icon: CalendarClock },
  { key: 'memory', label: 'Memory', icon: Sparkles },
  { key: 'contact', label: 'Contacts', icon: MessageSquare },
  { key: 'skills', label: 'Skills', icon: Wrench },
];

const HEADER_BTN_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/** 秘书面板：极简顶栏（状态 + 更多菜单 + 设置）+ 工作台首屏 + 底部今日交付入口 */
export function SecretaryPanel({ projectId }: { projectId?: string } = {}) {
  const { t } = useI18n();
  // 面板属于打开它的那个秘书会话，不跟着侧栏当前聚焦的秘书走
  const secretaryId = secretaryIdOfProject(projectId) ?? undefined;
  const secretary = useSecretaryStore((state) =>
    secretaryId
      ? (state.states[secretaryId] ??
        (state.focusedId === secretaryId ? state.secretary : undefined) ??
        state.secretary)
      : state.secretary
  );
  const focusProposal = useSecretaryStore((state) => state.focusProposal);
  const reload = useSecretaryStore((state) => state.reload);
  const [tab, setTab] = useState<Tab>('workbench');
  const [schedules, setSchedules] = useState<SecretaryScheduleView[]>([]);
  const loadSchedules = useCallback(() => {
    void window.electronAPI.secretary.listSchedules(secretaryId).then((result) => {
      if (result.ok) setSchedules(result.schedules);
    });
  }, [secretaryId]);
  // 定时由 Main 派生：打开时读一次，之后每次状态推送都重读
  useEffect(() => {
    loadSchedules();
    return window.electronAPI.secretary.onStateChanged(loadSchedules);
  }, [loadSchedules]);
  // 深链或手机按钮要定位某张卡：切回工作台，卡片由工作台滚过去并高亮
  useEffect(() => {
    if (focusProposal) setTab('workbench');
  }, [focusProposal]);

  const completedToday = useMemo(() => {
    const { completed, earlier } = secretaryDigest(secretary.board, Date.now()).today;
    return completed + earlier;
  }, [secretary.board]);

  const view = secretarySectionView(secretary, t);
  if (!view) return <SecretaryPanelPending onReload={() => void reload(secretaryId)} />;

  const activeSecondary = SECONDARY_VIEWS.find((entry) => entry.key === tab);

  return (
    <div data-enso="secretary-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
        <SecretaryAvatar
          name={view.name}
          color={view.color}
          image={view.image}
          needsYou={view.needsYou}
          running={view.running}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold leading-tight">{view.name}</p>
          <p
            data-enso="secretary-summary"
            className="mt-0.5 flex min-w-0 items-center truncate text-[11.5px] text-muted-foreground"
          >
            <SecretarySummary view={view} />
          </p>
        </div>
        <Menu>
          <MenuTrigger
            data-enso="secretary-panel-more"
            title={t('More actions')}
            aria-label={t('More actions')}
            className={HEADER_BTN_CLASS}
          >
            <MoreHorizontal className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" sideOffset={4} className="min-w-40">
            {SECONDARY_VIEWS.map(({ key, label, icon: Icon }) => (
              <MenuItem
                key={key}
                data-enso="secretary-panel-tab"
                data-tab={key}
                data-active={tab === key || undefined}
                onClick={() => setTab(key)}
                className="text-[12.5px]"
              >
                <Icon className="size-3.5 text-muted-foreground" />
                <span className="flex-1">{t(label)}</span>
                {key === 'schedules' && schedules.length > 0 && (
                  <span className="text-[11px] tabular-nums text-subtle-foreground">
                    {schedules.length}
                  </span>
                )}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        <button
          type="button"
          data-enso="secretary-panel-settings"
          onClick={() => openSecretarySettings(secretaryId)}
          title={t('Secretary settings')}
          aria-label={t('Secretary settings')}
          className={HEADER_BTN_CLASS}
        >
          <Settings className="size-4" />
        </button>
      </div>
      {activeSecondary && (
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-3 py-1.5">
          <button
            type="button"
            data-enso="secretary-panel-back"
            onClick={() => setTab('workbench')}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {t('Back to workbench')}
          </button>
          <span className="text-[12px] font-medium text-foreground">
            {t(activeSecondary.label)}
          </span>
        </div>
      )}
      <div
        data-enso="secretary-panel-scroll"
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {tab === 'workbench' && <SecretaryWorkbench name={view.name} secretaryId={secretaryId} />}
        {tab === 'daily' && <SecretaryDailyBoard secretaryId={secretaryId} />}
        {tab === 'memory' && <SecretaryMemoryPanel secretaryId={secretaryId} />}
        {tab === 'contact' && (
          // 手机上打不开桌面设置页，联系方式与主人身份必须在面板里直接管理；
          // 与设置页同一实现，分组卡片排版走同一套 frames
          <div className="px-3 pb-4">
            <SecretaryContactPanel
              secretaryId={secretaryId}
              frames={{
                owner: (node) => (
                  <SettingsSection title={t('Owner identity')} rowId="contacts.owner">
                    {node}
                  </SettingsSection>
                ),
                channels: (node) => (
                  <SettingsSection title={t('Contact channels')} rowId="contacts.channels">
                    {node}
                  </SettingsSection>
                ),
              }}
            />
          </div>
        )}
        {tab === 'skills' && <SecretarySkillsPanel secretaryId={secretaryId} />}
        {tab === 'schedules' && (
          <SecretarySchedulePanel
            schedules={schedules}
            name={view.name}
            onReload={loadSchedules}
            secretaryId={secretaryId}
          />
        )}
      </div>
      {tab === 'workbench' && (
        <button
          type="button"
          data-enso="secretary-panel-daily-link"
          onClick={() => setTab('daily')}
          className="flex shrink-0 items-center justify-between border-t border-border px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <span className="inline-flex items-center gap-1.5">
            <History className="size-3.5 shrink-0" />
            <span>
              {completedToday > 0
                ? t('{{count}} completed today', { count: completedToday })
                : t('Daily board')}
            </span>
          </span>
          <span className="inline-flex items-center gap-0.5 text-[11.5px] text-subtle-foreground">
            {t('View')}
            <ChevronRight className="size-3.5" />
          </span>
        </button>
      )}
    </div>
  );
}

/** 面板拿到的秘书状态还没启用（未读到或读到旧的）：给出提示并主动重读，不留一整块白 */
function SecretaryPanelPending({ onReload }: { onReload: () => void }) {
  const { t } = useI18n();
  const reloadRef = useRef(onReload);
  reloadRef.current = onReload;
  useEffect(() => {
    reloadRef.current();
  }, []);
  return (
    <div
      data-enso="secretary-panel-pending"
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <p className="text-[12.5px] text-muted-foreground">{t('Loading secretary…')}</p>
      <button
        type="button"
        data-enso="secretary-panel-reload"
        onClick={onReload}
        className="rounded-md border border-border px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground"
      >
        {t('Retry')}
      </button>
    </div>
  );
}
