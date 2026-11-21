import { Context } from "@deepseek-ai/cordis";
/**
 * 卡片文案（中英）。
 *
 * 客户端不能 import 宿主模块的运行时值，所以文案表独立放在这里；`zh` 是键的权威，
 * `en` 必须与它键一致（`test/locales.spec.ts` 会逐个比对）。
 *
 * @module dsh-loomy/client/locales
 */
declare const zh: {
  tabLabel: string;
  panelTitle: string;
  backToConversation: string;
  cardTitle: string;
  cardSubtitle: string;
  tabAccounts: string;
  tabModels: string;
  tabPoints: string;
  tabDisplay: string;
  statusLoading: string;
  signedOut: string;
  signedInCount: string;
  versionLabel: string;
  loadFailed: string;
  addAccountTitle: string;
  phonePlaceholder: string;
  passwordPlaceholder: string;
  signInSubmit: string;
  signInDone: string;
  signInHint: string;
  smsSend: string;
  smsPlaceholder: string;
  smsSubmit: string;
  smsHint: string;
  smsSent: string;
  sessionPlaceholder: string;
  sessionSubmit: string;
  sessionHint: string;
  accountNoLabel: string;
  accountPinned: string;
  accountNeedsLogin: string;
  accountPaused: string;
  accountRename: string;
  accountRenamePlaceholder: string;
  accountPin: string;
  accountUnpin: string;
  accountPause: string;
  accountResume: string;
  accountDelete: string;
  accountRelogin: string;
  accountSetPassword: string;
  accountSetPasswordPlaceholder: string;
  accountSessionDays: string;
  accountSessionExpired: string;
  accountNoPassword: string;
  accountDevid: string;
  accountConcurrency: string;
  accountPoints: string;
  accountPointsUnknown: string;
  modelsEmpty: string;
  modelsEmptyHint: string;
  refreshModels: string;
  refreshing: string;
  selectAll: string;
  selectInvert: string;
  selectionAll: string;
  selectionRestricted: string;
  selectionNone: string;
  selectionCount: string;
  modelVision: string;
  modelReasoning: string;
  modelTools: string;
  modelContext: string;
  modelOutput: string;
  modelLevels: string;
  modelMultiplier: string;
  pointsTitle: string;
  pointsRefresh: string;
  pointsRefreshing: string;
  pointsAvailable: string;
  pointsBalance: string;
  pointsDaily: string;
  pointsChecked: string;
  pointsNever: string;
  pointsError: string;
  pointsExhaustedTag: string;
  pointsExhaustedNotice: string;
  pointsNote: string;
  displayReadonly: string;
  showDock: string;
  showSidebar: string;
  showSettings: string;
  usageTitle: string;
  usageTodayRequests: string;
  usageTodayInput: string;
  usageTodayOutput: string;
  usageTodayPoints: string;
  usageScope: string;
  doctor: string;
  doctorOk: string;
  doctorFail: string;
  strategyLabel: string;
  strategyBalance: string;
  strategyRoundRobin: string;
  strategyLru: string;
  dockProvider: string;
  dockUsage: string;
  dockPoints: string;
  dockNone: string;
  dockNeedsLogin: string;
};
type LoomySettingsKey = typeof zh;
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.loomy': keyof LoomySettingsKey;
  }
  interface SlotMap {
    /** bundle 详情页里的配置卡片（rc.2 起），key = 包名。 */
    'plugins.bundle.config': {
      kind: 'keyed';
      scope: 'root';
      owner: {
        children?: never;
      };
    };
    'sidebar.panellist': {
      kind: 'list';
      scope: 'root';
      owner: {
        size: number;
        active: boolean;
      };
    };
    main: {
      kind: 'keyed';
      scope: 'root';
      owner: {
        children?: never;
      };
    };
    'settings.section': {
      kind: 'list';
      scope: 'root';
    };
  }
}
declare const name = "dsh-loomy-client";
declare const inject: string[];
declare function apply(ctx: Context): void;
export { apply, inject, name };