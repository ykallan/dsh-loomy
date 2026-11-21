window.__ModuleLoader__.load({
  id: "dsh-loomy",
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
// src/client/format.ts
/**
* 展示层的小格式化函数（纯函数，便于单测）。
*
* @module dsh-loomy/client/format
*/
/** `12345` → `12,345`。 */
function formatCount(value) {
	if (!Number.isFinite(value) || value <= 0) return "0";
	return Math.floor(value).toLocaleString("en-US");
}
/** `1_048_576` → `1M`、`170_000` → `170K`、`32768` → `32K`。 */
function formatTokens(value) {
	if (!Number.isFinite(value) || value <= 0) return "—";
	if (value >= 1e6) {
		const millions = value / 1e6;
		return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (value >= 1e3) {
		const thousands = value / 1e3;
		return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}K`;
	}
	return String(Math.round(value));
}
/** 相对时间：`刚刚` / `3 分钟前` / 具体日期。 */
function formatWhen(at, now = Date.now()) {
	if (at === void 0 || !Number.isFinite(at) || at <= 0) return "—";
	const delta = now - at;
	if (delta < 0) {
		const minutes = Math.max(1, Math.round(-delta / 6e4));
		return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
	}
	if (delta < 6e4) return "刚刚";
	if (delta < 36e5) return `${Math.round(delta / 6e4)} 分钟前`;
	if (delta < 864e5) return `${Math.round(delta / 36e5)} 小时前`;
	return new Date(at).toLocaleDateString();
}
/**
* 账号的显示名：备注名 → 打码手机号 → 用户 id → 未命名。
*
* `phone` 是宿主已经打码过的（`138****0000`），这里不再加工。
*/
function accountDisplayName(account, fallback) {
	return account.label ?? account.loginid ?? account.userid ?? (account.id === "" ? fallback : account.id);
}
// \0dsh-css:E:\codes\project_about\dsh-loomy\src\client\LoomyPluginCard.module.css.mjs
const css = ".xC5fIa_card{border:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-settings-card-fill,transparent);color:var(--dsw-alias-label-primary,inherit);flex-direction:column;gap:12px;padding:16px;font-size:13px;line-height:1.5;display:flex}.xC5fIa_header{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.xC5fIa_headerMain{flex-direction:column;gap:2px;display:flex}.xC5fIa_title{margin:0;font-size:15px;font-weight:600}.xC5fIa_subtitle{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);margin:0;font-size:12px}.xC5fIa_headerMeta{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;display:flex}.xC5fIa_tabs{align-self:flex-start}.xC5fIa_section{flex-direction:column;gap:10px;display:flex}.xC5fIa_signInBox{flex-wrap:wrap;align-items:center;gap:10px;display:flex}.xC5fIa_tokenInput{flex:220px;min-width:180px}.xC5fIa_list{flex-direction:column;gap:8px;display:flex}.xC5fIa_accountRow{border:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);border-radius:var(--dsw-radius-md,8px);justify-content:space-between;align-items:flex-start;gap:12px;padding:8px 10px;display:flex}.xC5fIa_accountMain{flex-direction:column;gap:4px;min-width:0;display:flex}.xC5fIa_accountTitle{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.xC5fIa_accountName{font-weight:600}.xC5fIa_accountMeta{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);flex-wrap:wrap;gap:10px;font-size:12px;display:flex}.xC5fIa_accountActions{flex-wrap:wrap;justify-content:flex-end;gap:4px;display:flex}.xC5fIa_inlineForm{align-items:center;gap:6px;display:flex}.xC5fIa_modelRow{border-radius:var(--dsw-radius-md,8px);cursor:pointer;align-items:flex-start;gap:8px;padding:6px 8px;display:flex}.xC5fIa_modelRow:hover{background:var(--dsw-alias-fill-secondary,#7f7f7f14)}.xC5fIa_modelMain{flex-direction:column;gap:2px;min-width:0;display:flex}.xC5fIa_modelTitle{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.xC5fIa_modelName{font-weight:600}.xC5fIa_modelMeta{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);flex-wrap:wrap;gap:10px;font-size:12px;display:flex}.xC5fIa_toolbar{flex-wrap:wrap;align-items:center;gap:10px;display:flex}.xC5fIa_checkinRow{border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);align-items:center;gap:10px;padding:6px 8px;display:flex}.xC5fIa_switchRow{flex-wrap:wrap;align-items:center;gap:10px;display:flex}.xC5fIa_quotaBox{border:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);border-radius:var(--dsw-radius-md,8px);flex-direction:column;gap:8px;padding:10px;display:flex}.xC5fIa_quotaTitle{font-weight:600}.xC5fIa_quotaExhausted{flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;display:flex}.xC5fIa_note{border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-fill-secondary,#7f7f7f14);color:var(--dsw-alias-label-tertiary,#7f7f7fe6);margin:0;padding:8px 10px;font-size:12px}.xC5fIa_muted{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);font-size:12px}.xC5fIa_warnText{color:var(--dsw-alias-status-warning,#d97706);font-weight:700}.xC5fIa_error{border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-status-danger,#dc2626);color:var(--dsw-alias-status-danger,#dc2626);word-break:break-word;padding:8px 10px;font-size:12px}.xC5fIa_notice{border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-status-success,#16a34a);color:var(--dsw-alias-status-success,#16a34a);padding:8px 10px;font-size:12px}.xC5fIa_footer{border-top:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);color:var(--dsw-alias-label-secondary,inherit);flex-wrap:wrap;align-items:center;gap:12px;padding-top:8px;font-size:12px;display:flex}.xC5fIa_footerTitle{font-weight:600}.xC5fIa_panel{flex-direction:column;gap:12px;height:100%;padding:16px;display:flex;overflow:auto}.xC5fIa_panelHeader{align-items:center;gap:10px;display:flex}.xC5fIa_panelTitle{margin:0;font-size:15px;font-weight:600}.xC5fIa_dockLine{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);white-space:nowrap;align-items:center;gap:6px;font-size:12px;display:flex}.xC5fIa_dockSeparator{opacity:.5}";
const tagId = "dsh-loomy/LoomyPluginCard.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-loomy";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var LoomyPluginCard_module_css_default = {
	"tokenInput": "xC5fIa_tokenInput",
	"checkinRow": "xC5fIa_checkinRow",
	"title": "xC5fIa_title",
	"quotaExhausted": "xC5fIa_quotaExhausted",
	"modelMeta": "xC5fIa_modelMeta",
	"warnText": "xC5fIa_warnText",
	"accountRow": "xC5fIa_accountRow",
	"notice": "xC5fIa_notice",
	"footer": "xC5fIa_footer",
	"dockSeparator": "xC5fIa_dockSeparator",
	"error": "xC5fIa_error",
	"switchRow": "xC5fIa_switchRow",
	"modelTitle": "xC5fIa_modelTitle",
	"accountMain": "xC5fIa_accountMain",
	"accountMeta": "xC5fIa_accountMeta",
	"modelRow": "xC5fIa_modelRow",
	"accountActions": "xC5fIa_accountActions",
	"note": "xC5fIa_note",
	"headerMain": "xC5fIa_headerMain",
	"headerMeta": "xC5fIa_headerMeta",
	"toolbar": "xC5fIa_toolbar",
	"quotaBox": "xC5fIa_quotaBox",
	"header": "xC5fIa_header",
	"accountName": "xC5fIa_accountName",
	"quotaTitle": "xC5fIa_quotaTitle",
	"modelMain": "xC5fIa_modelMain",
	"section": "xC5fIa_section",
	"panel": "xC5fIa_panel",
	"subtitle": "xC5fIa_subtitle",
	"signInBox": "xC5fIa_signInBox",
	"list": "xC5fIa_list",
	"dockLine": "xC5fIa_dockLine",
	"card": "xC5fIa_card",
	"modelName": "xC5fIa_modelName",
	"accountTitle": "xC5fIa_accountTitle",
	"muted": "xC5fIa_muted",
	"panelTitle": "xC5fIa_panelTitle",
	"footerTitle": "xC5fIa_footerTitle",
	"panelHeader": "xC5fIa_panelHeader",
	"tabs": "xC5fIa_tabs",
	"inlineForm": "xC5fIa_inlineForm"
};
// src/client/LoomyDock.tsx
/**
* 对话输入框下方那一行：`Loomy · 模型 · 今日 tokens · 花费点数`。
*
* 只在当前模型确实来自 `loomy` 时渲染 —— 别的 provider 的对话不该出现这一行。
* 状态每 60 秒刷一次（够用，且不给 `/status` 添压力）。
*
* @module dsh-loomy/client/LoomyDock
*/
/** 这个 provider 路由的名字（客户端不能 import 宿主模块，所以这里单独抄一份）。 */
const LOOMY_PROVIDER = "loomy";
/** 状态刷新间隔。 */
const REFRESH_INTERVAL_MS = 6e4;
/** 读当前选中的 provider/model。 */
function readSelection(useProjection) {
	if (useProjection === void 0) return void 0;
	try {
		const value = useProjection("modelSelection");
		if (typeof value !== "object" || value === null) return void 0;
		const raw = value;
		return {
			...typeof raw.provider === "string" ? { provider: raw.provider } : {},
			...typeof raw.model === "string" ? { model: raw.model } : {},
			...typeof raw.name === "string" ? { name: raw.name } : {}
		};
	} catch {
		return;
	}
}
function LoomyDock({ useProjection, t, onOpenSettings }) {
	const [status, setStatus] = (0, react.useState)(void 0);
	const selection = readSelection(useProjection);
	const isLoomy = selection?.provider === LOOMY_PROVIDER;
	(0, react.useEffect)(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const response = await fetch("/api/loomy/status", { headers: { Accept: "application/json" } });
				if (!response.ok) return;
				const parsed = await response.json();
				if (!cancelled && parsed.status !== void 0) setStatus(parsed.status);
			} catch {}
		};
		load();
		const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);
	if (status === void 0 || !isLoomy) return null;
	if (status.dock.dock !== true) return null;
	const modelName = selection?.name ?? selection?.model ?? "";
	const today = status.usage.today;
	const tokens = today.inputTokens + today.outputTokens;
	const needsLogin = status.accounts.filter((account) => account.needsLogin).length;
	const clickable = typeof onOpenSettings === "function";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: LoomyPluginCard_module_css_default.dockLine,
		role: clickable ? "button" : void 0,
		tabIndex: clickable ? 0 : void 0,
		onClick: clickable ? () => onOpenSettings?.() : void 0,
		onKeyDown: clickable ? (event) => {
			if (event.key === "Enter" || event.key === " ") onOpenSettings?.();
		} : void 0,
		title: status.accounts.length === 0 ? t("dockNone") : void 0,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: modelName === "" ? t("dockProvider") : `${t("dockProvider")} · ${modelName}` }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: LoomyPluginCard_module_css_default.dockSeparator,
				children: "|"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("dockUsage", { tokens: formatCount(tokens) }) }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: LoomyPluginCard_module_css_default.dockSeparator,
				children: "|"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("dockPoints", { points: formatCount(today.points) }) }),
			needsLogin === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: LoomyPluginCard_module_css_default.dockSeparator,
				children: "|"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: LoomyPluginCard_module_css_default.warnText,
				children: t("dockNeedsLogin", { count: needsLogin })
			})] })
		]
	});
}
// src/client/dock-store.ts
const DEFAULT_DOCK_FLAGS = {
	dock: true,
	sidebar: false,
	settingsEntry: true
};
let snapshot = {
	dock: DEFAULT_DOCK_FLAGS,
	writable: false,
	loaded: false
};
const listeners = /* @__PURE__ */ new Set();
function dockSnapshot() {
	return snapshot;
}
function publishDock(patch) {
	snapshot = {
		dock: {
			...snapshot.dock,
			...patch.dock ?? {}
		},
		writable: patch.writable ?? snapshot.writable,
		loaded: true
	};
	for (const listener of [...listeners]) try {
		listener();
	} catch {}
}
function subscribeDock(listener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
// src/client/panel-switch.ts
function createWantedSwitch(initial) {
	let value = initial;
	const listeners = /* @__PURE__ */ new Set();
	return {
		get: () => value,
		set: (next) => {
			if (next === value) return;
			value = next;
			for (const listener of [...listeners]) try {
				listener();
			} catch {}
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}
/** 侧边栏图标列入口：缺省关（图标列是全宿主共用资源）。 */
const sidebarEntrySwitch = createWantedSwitch(false);
/** 设置左侧导航入口：缺省开。 */
const settingsEntrySwitch = createWantedSwitch(true);
const sidebarPanelWanted = sidebarEntrySwitch.get;
const setSidebarPanelWanted = sidebarEntrySwitch.set;
const subscribeSidebarPanelWanted = sidebarEntrySwitch.subscribe;
const settingsEntryWanted = settingsEntrySwitch.get;
const setSettingsEntryWanted = settingsEntrySwitch.set;
const subscribeSettingsEntryWanted = settingsEntrySwitch.subscribe;
// src/client/LoomyPluginCard.tsx
/**
* Loomy 插件卡片（设置页 / 侧边栏整页 / bundle 详情页共用同一个组件）。
*
* 卡片自己读状态：`GET /api/loomy/status` 一次拿到账号、模型、用量、点数与显示开关，
* 之后每 30 秒刷一次。所有写操作都返回新的状态文档，直接替换本地快照 —— 不靠「祈祷
* 下一次轮询能反映出来」。
*
* 登录是**服务端**的，所以这里没有「打开浏览器授权」的跳转：手机号+密码直接 POST，
* 卡片等 HTTP 响应即可。短信路径分两步（发码 → 填码），因为没有密码的账号只能这样
* 拿一次会话。
*
* @module dsh-loomy/client/LoomyPluginCard
*/
/** 状态轮询间隔。 */
const POLL_MS = 3e4;
async function requestJson(path, init) {
	const response = await fetch(path, {
		...init,
		headers: {
			Accept: "application/json",
			...init?.body === void 0 ? {} : { "Content-Type": "application/json" },
			...init?.headers ?? {}
		}
	});
	const text = await response.text();
	const parsed = text === "" ? {} : JSON.parse(text);
	if (!response.ok) {
		const message = typeof parsed === "object" && parsed !== null && "error" in parsed ? String(parsed.error) : `HTTP ${response.status}`;
		throw new Error(message);
	}
	return parsed;
}
function statusOfDot(account) {
	if (account.paused) return "idle";
	if (account.needsLogin) return "error";
	if (account.slot?.coolUntil !== void 0 && account.slot.coolUntil > Date.now()) return "warning";
	return "done";
}
/** 一个账号行。 */
function AccountRow({ account, t, pending, onAction }) {
	const [renaming, setRenaming] = (0, react.useState)(false);
	const [draft, setDraft] = (0, react.useState)(account.label ?? "");
	const [settingPassword, setSettingPassword] = (0, react.useState)(false);
	const [password, setPassword] = (0, react.useState)("");
	const name = accountDisplayName(account, t("accountNoLabel"));
	const points = account.points?.snapshot?.available;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: LoomyPluginCard_module_css_default.accountRow,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: LoomyPluginCard_module_css_default.accountMain,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LoomyPluginCard_module_css_default.accountTitle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: statusOfDot(account) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: LoomyPluginCard_module_css_default.accountName,
							children: name
						}),
						account.pinned ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "info",
							children: t("accountPinned")
						}) : null,
						account.needsLogin ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "danger",
							children: t("accountNeedsLogin")
						}) : null,
						account.paused ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "neutral",
							children: t("accountPaused")
						}) : null,
						account.hasPassword ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "warning",
							children: t("accountNoPassword")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: points === void 0 ? "outline" : points > 0 ? "success" : "warning",
							children: points === void 0 ? t("accountPointsUnknown") : t("accountPoints", { points: formatCount(points) })
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LoomyPluginCard_module_css_default.accountMeta,
					children: [
						account.loginid === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.id }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.loginid }),
						account.sessionDaysLeft === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("accountSessionExpired") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("accountSessionDays", { days: account.sessionDaysLeft }) }),
						account.slot === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("accountConcurrency", {
							active: account.slot.activeConcurrent,
							max: account.slot.maxConcurrent
						}) }),
						account.devid === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("accountDevid", { devid: account.devid }) }),
						account.slot?.lastError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: LoomyPluginCard_module_css_default.warnText,
							title: account.slot.lastError,
							children: "!"
						})
					]
				}),
				renaming ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LoomyPluginCard_module_css_default.inlineForm,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							value: draft,
							placeholder: t("accountRenamePlaceholder"),
							onChange: (event) => setDraft(event.target.value)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "outline",
							disabled: pending,
							onClick: () => {
								onAction("rename", draft);
								setRenaming(false);
							},
							children: "OK"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => setRenaming(false),
							children: "×"
						})
					]
				}) : null,
				settingPassword ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LoomyPluginCard_module_css_default.inlineForm,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							type: "password",
							value: password,
							placeholder: t("accountSetPasswordPlaceholder"),
							onChange: (event) => setPassword(event.target.value)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "outline",
							disabled: pending || password === "",
							onClick: () => {
								onAction("password", password);
								setPassword("");
								setSettingPassword(false);
							},
							children: "OK"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => setSettingPassword(false),
							children: "×"
						})
					]
				}) : null
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: LoomyPluginCard_module_css_default.accountActions,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => setRenaming((value) => !value),
					children: t("accountRename")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => setSettingPassword((value) => !value),
					children: t("accountSetPassword")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending || !account.hasPassword,
					onClick: () => onAction("relogin"),
					children: t("accountRelogin")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => onAction(account.pinned ? "unpin" : "pin"),
					children: account.pinned ? t("accountUnpin") : t("accountPin")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => onAction(account.paused ? "resume" : "pause"),
					children: account.paused ? t("accountResume") : t("accountPause")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => onAction("remove"),
					children: t("accountDelete")
				})
			]
		})]
	});
}
/** 一个模型行。 */
function ModelRow({ model, enabled, t, onToggle }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
		className: LoomyPluginCard_module_css_default.modelRow,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
			checked: enabled,
			onChange: onToggle,
			label: ""
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: LoomyPluginCard_module_css_default.modelMain,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: LoomyPluginCard_module_css_default.modelTitle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoomyPluginCard_module_css_default.modelName,
						children: model.name
					}),
					model.name === model.id ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoomyPluginCard_module_css_default.muted,
						children: model.id
					}),
					model.supportsImages ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: "info",
						children: t("modelVision")
					}) : null,
					model.reasoning ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: "outline",
						children: t("modelReasoning")
					}) : null,
					model.toolCall ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: "outline",
						children: t("modelTools")
					}) : null,
					model.multiplier === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: "neutral",
						children: t("modelMultiplier", { value: model.multiplier })
					})
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: LoomyPluginCard_module_css_default.modelMeta,
				children: [
					model.contextWindow === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelContext", { tokens: formatTokens(model.contextWindow) }) }),
					model.maxTokens === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelOutput", { tokens: formatTokens(model.maxTokens) }) }),
					model.levels === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelLevels", { levels: model.levels.join("/") }) })
				]
			})]
		})]
	});
}
function LoomyPluginCard({ t }) {
	const [status, setStatus] = (0, react.useState)(void 0);
	const [selection, setSelection] = (0, react.useState)(void 0);
	const [error, setError] = (0, react.useState)(void 0);
	const [notice, setNotice] = (0, react.useState)(void 0);
	const [busy, setBusy] = (0, react.useState)(void 0);
	const [tab, setTab] = (0, react.useState)("accounts");
	const [phone, setPhone] = (0, react.useState)("");
	const [password, setPassword] = (0, react.useState)("");
	const [smsCode, setSmsCode] = (0, react.useState)("");
	const [smsMsgid, setSmsMsgid] = (0, react.useState)(void 0);
	const [session, setSession] = (0, react.useState)("");
	const [dock, setDock] = (0, react.useState)(dockSnapshot().dock ?? DEFAULT_DOCK_FLAGS);
	const mounted = (0, react.useRef)(true);
	const refresh = async () => {
		try {
			const [next, nextSelection] = await Promise.all([requestJson("/api/loomy/status"), requestJson("/api/loomy/enabled-models")]);
			if (!mounted.current) return;
			setStatus(next.status);
			setSelection(nextSelection.selection);
			setDock(next.status.dock);
			publishDock({
				dock: next.status.dock,
				writable: next.status.writable
			});
			setSettingsEntryWanted(next.status.dock.settingsEntry);
			setSidebarPanelWanted(next.status.dock.sidebar);
			setError(void 0);
		} catch (caught) {
			if (!mounted.current) return;
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};
	(0, react.useEffect)(() => {
		mounted.current = true;
		refresh();
		const timer = setInterval(() => void refresh(), POLL_MS);
		const unsubscribe = subscribeDock(() => setDock(dockSnapshot().dock));
		return () => {
			mounted.current = false;
			clearInterval(timer);
			unsubscribe();
		};
	}, []);
	const tabs = (0, react.useMemo)(() => [
		{
			value: "accounts",
			label: t("tabAccounts"),
			id: "loomy-tab-accounts",
			panelId: "loomy-panel-accounts"
		},
		{
			value: "models",
			label: t("tabModels"),
			id: "loomy-tab-models",
			panelId: "loomy-panel-models"
		},
		{
			value: "points",
			label: t("tabPoints"),
			id: "loomy-tab-points",
			panelId: "loomy-panel-points"
		},
		{
			value: "display",
			label: t("tabDisplay"),
			id: "loomy-tab-display",
			panelId: "loomy-panel-display"
		}
	], [t]);
	const accountAction = async (id, action, value) => {
		setBusy(`${action}:${id}`);
		try {
			if (action === "remove") {
				const next = await requestJson(`/api/loomy/accounts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
				setStatus(next.status);
			} else {
				const body = { id };
				if (action === "pause") body.paused = true;
				if (action === "resume") body.paused = false;
				if (action === "pin") body.pinned = true;
				if (action === "unpin") body.pinned = false;
				if (action === "relogin") body.relogin = true;
				if (action === "rename") body.label = value ?? "";
				if (action === "password") body.password = value ?? "";
				const next = await requestJson("/api/loomy/accounts", {
					method: "POST",
					body: JSON.stringify(body)
				});
				setStatus(next.status);
			}
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const signIn = async () => {
		setBusy("login");
		setNotice(void 0);
		try {
			const trimmedPhone = phone.trim();
			const next = await requestJson("/api/loomy/login", {
				method: "POST",
				body: JSON.stringify({
					loginid: trimmedPhone,
					password
				})
			});
			setStatus(next.status);
			setPhone("");
			setPassword("");
			setNotice(t("signInDone"));
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const sendSmsCode = async () => {
		setBusy("sms-send");
		setNotice(void 0);
		try {
			const result = await requestJson("/api/loomy/sms", {
				method: "POST",
				body: JSON.stringify({ loginid: phone.trim() })
			});
			setSmsMsgid(result.msgid);
			setNotice(t("smsSent"));
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const signInWithSms = async () => {
		if (smsMsgid === void 0) return;
		setBusy("sms-verify");
		try {
			const next = await requestJson("/api/loomy/sms", {
				method: "POST",
				body: JSON.stringify({
					loginid: phone.trim(),
					code: smsCode.trim(),
					msgid: smsMsgid
				})
			});
			setStatus(next.status);
			setSmsCode("");
			setSmsMsgid(void 0);
			setPhone("");
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const saveSession = async () => {
		setBusy("session");
		try {
			const next = await requestJson("/api/loomy/session", {
				method: "POST",
				body: JSON.stringify({ session: session.trim() })
			});
			setStatus(next.status);
			setSession("");
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	/** 写回一份勾选（模式 + id）。宿主会把「模式」也存下来。 */
	const saveSelection = async (mode, enabledModels) => {
		setBusy("models");
		try {
			const result = await requestJson("/api/loomy/enabled-models", {
				method: "POST",
				body: JSON.stringify({
					mode,
					enabledModels
				})
			});
			setSelection(result.selection);
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const toggleModel = async (model, next) => {
		if (selection === void 0) return;
		const set = new Set(selection.choices.filter((choice) => choice.enabled).map((choice) => choice.id));
		if (next) set.add(model.id);
		else set.delete(model.id);
		const all = selection.choices.map((choice) => choice.id);
		if (set.size === all.length) await saveSelection("all", []);
		else await saveSelection("custom", [...set]);
	};
	const selectAll = async () => {
		await saveSelection("all", []);
	};
	/** 反选：语义在宿主侧算（`catalog.ts`），这里只按返回结果重绘。 */
	const invertModels = async () => {
		setBusy("invert-models");
		try {
			const result = await requestJson("/api/loomy/selection/invert", {
				method: "POST",
				body: "{}"
			});
			setSelection(result.selection);
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const refreshModels = async () => {
		setBusy("refresh-models");
		try {
			const result = await requestJson("/api/loomy/refresh-models", { method: "POST" });
			setSelection(result.selection);
			setStatus(result.status);
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	/** 「刷新点数」：真的去查上游账本（不是探活）。 */
	const refreshPoints = async () => {
		setBusy("points");
		try {
			const result = await requestJson("/api/loomy/points", {
				method: "POST",
				body: "{}"
			});
			setStatus(result.status);
			setNotice(result.outcome.message);
			setError(result.outcome.ok ? void 0 : result.outcome.message);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	/** 体检：读一次 /doctor，把结果写进 notice/error。 */
	const diagnose = async () => {
		setBusy("doctor");
		try {
			const result = await requestJson("/api/loomy/doctor");
			const failed = result.report.checks.find((check) => !check.ok);
			if (result.report.ok) {
				setNotice(t("doctorOk"));
				setError(void 0);
			} else {
				setNotice(void 0);
				setError(t("doctorFail", { detail: failed === void 0 ? "unknown" : `${failed.id}: ${failed.detail}` }));
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const setDockFlag = async (patch) => {
		setDock((current) => ({
			...current,
			...patch
		}));
		publishDock({ dock: patch });
		if (patch.sidebar !== void 0) setSidebarPanelWanted(patch.sidebar);
		if (patch.settingsEntry !== void 0) setSettingsEntryWanted(patch.settingsEntry);
		try {
			await requestJson("/api/loomy/dock", {
				method: "POST",
				body: JSON.stringify(patch)
			});
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};
	const accounts = status?.accounts ?? [];
	const usage = status?.usage;
	const exhausted = accounts.filter((account) => account.points?.exhaustedAt !== void 0);
	const totalPoints = accounts.filter((account) => account.points?.snapshot?.available !== void 0).reduce((sum, account) => sum + (account.points?.snapshot?.available ?? 0), 0);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: LoomyPluginCard_module_css_default.card,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				className: LoomyPluginCard_module_css_default.header,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LoomyPluginCard_module_css_default.headerMain,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: LoomyPluginCard_module_css_default.title,
						children: t("cardTitle")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: LoomyPluginCard_module_css_default.subtitle,
						children: t("cardSubtitle")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LoomyPluginCard_module_css_default.headerMeta,
					children: [status === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoomyPluginCard_module_css_default.muted,
						children: t("statusLoading")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: accounts.length > 0 ? "success" : "warning",
						children: accounts.length === 0 ? t("signedOut") : t("signedInCount", { count: accounts.length })
					}), status === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoomyPluginCard_module_css_default.muted,
						children: t("versionLabel", { version: status.version })
					})]
				})]
			}),
			error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: LoomyPluginCard_module_css_default.error,
				children: t("loadFailed", { message: error })
			}),
			notice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: LoomyPluginCard_module_css_default.notice,
				children: notice
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
				items: tabs,
				value: tab,
				onChange: setTab,
				label: t("cardTitle"),
				className: LoomyPluginCard_module_css_default.tabs,
				size: "sm"
			}),
			tab === "accounts" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				id: "loomy-panel-accounts",
				role: "tabpanel",
				"aria-labelledby": "loomy-tab-accounts",
				className: LoomyPluginCard_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LoomyPluginCard_module_css_default.signInBox,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								value: phone,
								placeholder: t("phonePlaceholder"),
								onChange: (event) => setPhone(event.target.value),
								className: LoomyPluginCard_module_css_default.tokenInput
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								type: "password",
								value: password,
								placeholder: t("passwordPlaceholder"),
								onChange: (event) => setPassword(event.target.value),
								className: LoomyPluginCard_module_css_default.tokenInput
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								disabled: busy === "login" || phone.trim() === "" || password === "",
								onClick: () => void signIn(),
								children: t("signInSubmit")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: LoomyPluginCard_module_css_default.note,
						children: t("signInHint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LoomyPluginCard_module_css_default.signInBox,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: busy === "sms-send" || phone.trim() === "",
								onClick: () => void sendSmsCode(),
								children: t("smsSend")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								value: smsCode,
								placeholder: t("smsPlaceholder"),
								onChange: (event) => setSmsCode(event.target.value),
								className: LoomyPluginCard_module_css_default.tokenInput
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: busy === "sms-verify" || smsMsgid === void 0 || smsCode.trim() === "",
								onClick: () => void signInWithSms(),
								children: t("smsSubmit")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: LoomyPluginCard_module_css_default.muted,
								children: t("smsHint")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LoomyPluginCard_module_css_default.signInBox,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								value: session,
								placeholder: t("sessionPlaceholder"),
								onChange: (event) => setSession(event.target.value),
								className: LoomyPluginCard_module_css_default.tokenInput
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: busy === "session" || session.trim() === "",
								onClick: () => void saveSession(),
								children: t("sessionSubmit")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: LoomyPluginCard_module_css_default.muted,
								children: t("sessionHint")
							})
						]
					}),
					accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: LoomyPluginCard_module_css_default.muted,
						children: t("signedOut")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: LoomyPluginCard_module_css_default.list,
						children: accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
							account,
							t,
							pending: busy !== void 0 && busy.endsWith(`:${account.id}`),
							onAction: (action, value) => void accountAction(account.id, action, value)
						}, account.id))
					})
				]
			}) : null,
			tab === "models" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				id: "loomy-panel-models",
				role: "tabpanel",
				"aria-labelledby": "loomy-tab-models",
				className: LoomyPluginCard_module_css_default.section,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LoomyPluginCard_module_css_default.toolbar,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							disabled: busy === "refresh-models",
							onClick: () => void refreshModels(),
							children: busy === "refresh-models" ? t("refreshing") : t("refreshModels")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							disabled: selection === void 0 || busy === "models",
							onClick: () => void selectAll(),
							children: t("selectAll")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							disabled: selection === void 0 || busy === "invert-models" || (selection?.choices ?? []).length === 0,
							onClick: () => void invertModels(),
							children: t("selectInvert")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: LoomyPluginCard_module_css_default.muted,
							children: selectionSummary(selection, t)
						})
					]
				}), (selection?.choices ?? []).length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: LoomyPluginCard_module_css_default.muted,
					children: t("modelsEmpty")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: LoomyPluginCard_module_css_default.muted,
					children: t("modelsEmptyHint")
				})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: LoomyPluginCard_module_css_default.list,
					children: (selection?.choices ?? []).map((choice) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {
						model: choice,
						enabled: choice.enabled,
						t,
						onToggle: (next) => void toggleModel(choice, next)
					}, choice.id))
				})]
			}) : null,
			tab === "points" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				id: "loomy-panel-points",
				role: "tabpanel",
				"aria-labelledby": "loomy-tab-points",
				className: LoomyPluginCard_module_css_default.section,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LoomyPluginCard_module_css_default.quotaBox,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: LoomyPluginCard_module_css_default.toolbar,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LoomyPluginCard_module_css_default.quotaTitle,
									children: t("pointsTitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: exhausted.length > 0 ? "danger" : "outline",
									children: t("pointsAvailable", { points: formatCount(totalPoints) })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: LoomyPluginCard_module_css_default.muted,
									children: [
										t("strategyLabel"),
										"：",
										strategyLabel(status?.strategy, t)
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									disabled: busy === "points",
									onClick: () => void refreshPoints(),
									children: busy === "points" ? t("pointsRefreshing") : t("pointsRefresh")
								})
							]
						}),
						exhausted.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: LoomyPluginCard_module_css_default.quotaExhausted,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: "danger",
									children: t("pointsExhaustedTag")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("pointsExhaustedNotice", { count: exhausted.length }) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LoomyPluginCard_module_css_default.muted,
									children: exhausted.map((account) => accountDisplayName(account, t("accountNoLabel"))).join(", ")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: LoomyPluginCard_module_css_default.note,
							children: t("pointsNote")
						})
					]
				}), accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: LoomyPluginCard_module_css_default.muted,
					children: t("signedOut")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: LoomyPluginCard_module_css_default.list,
					children: accounts.map((account) => {
						const state = account.points;
						const snapshot = state?.snapshot;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: LoomyPluginCard_module_css_default.checkinRow,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: state === void 0 ? "idle" : state.exhaustedAt !== void 0 ? "error" : state.error !== void 0 ? "warning" : "done" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LoomyPluginCard_module_css_default.accountName,
									children: accountDisplayName(account, t("accountNoLabel"))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LoomyPluginCard_module_css_default.muted,
									children: snapshot === void 0 ? t("pointsNever") : `${t("pointsAvailable", { points: formatCount(snapshot.available ?? 0) })} · ${t("pointsBalance", { points: formatCount(snapshot.balance ?? 0) })} · ${t("pointsDaily", { points: formatCount(snapshot.dailyBalance ?? 0) })}`
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LoomyPluginCard_module_css_default.muted,
									children: state?.checkedAt === void 0 ? "" : t("pointsChecked", { when: formatWhen(state.checkedAt) })
								}),
								state?.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LoomyPluginCard_module_css_default.warnText,
									children: t("pointsError", { message: state.error })
								})
							]
						}, account.id);
					})
				})]
			}) : null,
			tab === "display" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				id: "loomy-panel-display",
				role: "tabpanel",
				"aria-labelledby": "loomy-tab-display",
				className: LoomyPluginCard_module_css_default.section,
				children: [
					status !== void 0 && status.writable !== true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: LoomyPluginCard_module_css_default.muted,
						children: t("displayReadonly")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LoomyPluginCard_module_css_default.switchRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: dock.dock,
							onChange: (next) => void setDockFlag({ dock: next }),
							label: t("showDock")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("showDock") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LoomyPluginCard_module_css_default.switchRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: dock.sidebar,
							onChange: (next) => void setDockFlag({ sidebar: next }),
							label: t("showSidebar")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("showSidebar") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LoomyPluginCard_module_css_default.switchRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: dock.settingsEntry,
							onChange: (next) => void setDockFlag({ settingsEntry: next }),
							label: t("showSettings")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("showSettings") })]
					})
				]
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
				className: LoomyPluginCard_module_css_default.footer,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoomyPluginCard_module_css_default.footerTitle,
						children: t("usageTitle")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageTodayRequests", { count: formatCount(usage?.today.requests ?? 0) }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageTodayInput", { tokens: formatCount(usage?.today.inputTokens ?? 0) }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageTodayOutput", { tokens: formatCount(usage?.today.outputTokens ?? 0) }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageTodayPoints", { points: formatCount(usage?.today.points ?? 0) }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoomyPluginCard_module_css_default.muted,
						title: t("usageScope"),
						children: t("usageScope")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "ghost",
						disabled: busy === "doctor",
						onClick: () => void diagnose(),
						children: t("doctor")
					})
				]
			})
		]
	});
}
/** 策略名的翻译（未知值原样显示，别让卡片因为一个枚举值空白）。 */
function strategyLabel(strategy, t) {
	if (strategy === "balance") return t("strategyBalance");
	if (strategy === "round_robin") return t("strategyRoundRobin");
	if (strategy === "lru") return t("strategyLru");
	return strategy ?? "";
}
/**
* 勾选状态那一句话。
*
* 判据是**模式**而不是「有没有未勾选项」：`none`（一个都不给）时每个勾选框都是空的，
* 用 `restricted` 判断会显示成「只暴露勾选的模型」，读起来像是还有得用。
*/
function selectionSummary(selection, t) {
	if (selection === void 0) return t("statusLoading");
	const total = selection.choices.length;
	const enabled = selection.choices.filter((choice) => choice.enabled).length;
	if (total === 0) return selection.mode === "none" ? t("selectionNone") : t("modelsEmpty");
	if (selection.mode === "none" || enabled === 0) return t("selectionNone");
	if (enabled === total) return t("selectionAll");
	return t("selectionCount", {
		enabled,
		total
	});
}
// src/client/LoomyPanel.tsx
/** 侧边栏图标（16×16：一个对话气泡 + 一个点，呼应「助手」）。 */
function LoomyPanelIcon({ size = 16 }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		width: size,
		height: size,
		viewBox: "0 0 16 16",
		fill: "none",
		"aria-hidden": "true",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M2.4 4.2c0-.9.7-1.6 1.6-1.6h8c.9 0 1.6.7 1.6 1.6v5.2c0 .9-.7 1.6-1.6 1.6H7.1L4 13.4v-2.4H4c-.9 0-1.6-.7-1.6-1.6V4.2Z",
				stroke: "currentColor",
				strokeWidth: "1.2",
				strokeLinejoin: "round"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "5.9",
				cy: "7",
				r: "1",
				fill: "currentColor"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "8",
				cy: "7",
				r: "1",
				fill: "currentColor"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "10.1",
				cy: "7",
				r: "1",
				fill: "currentColor"
			})
		]
	});
}
/** 侧边栏里的整页版本：一个返回按钮 + 同一张卡片。 */
function LoomyPanelPage({ t, backToConversation }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: LoomyPluginCard_module_css_default.panel,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: LoomyPluginCard_module_css_default.panelHeader,
			children: [backToConversation === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: "ghost",
				size: "sm",
				onClick: () => backToConversation(),
				children: ["← ", t("backToConversation")]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				className: LoomyPluginCard_module_css_default.panelTitle,
				children: t("panelTitle")
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoomyPluginCard, { t })]
	});
}
// src/client/locales.ts
/**
* 卡片文案（中英）。
*
* 客户端不能 import 宿主模块的运行时值，所以文案表独立放在这里；`zh` 是键的权威，
* `en` 必须与它键一致（`test/locales.spec.ts` 会逐个比对）。
*
* @module dsh-loomy/client/locales
*/
const zh = {
	tabLabel: "Loomy",
	panelTitle: "Loomy",
	backToConversation: "返回对话",
	cardTitle: "Loomy 连接",
	cardSubtitle: "把 Loomy 的模型额度接到 DSH：手机号+密码在服务端登录，一次登录换来 14 天会话。",
	tabAccounts: "账号",
	tabModels: "模型",
	tabPoints: "点数",
	tabDisplay: "显示",
	statusLoading: "读取中…",
	signedOut: "还没有账号",
	signedInCount: "{count} 个账号",
	versionLabel: "v{version}",
	loadFailed: "读取状态失败：{message}",
	addAccountTitle: "添加账号",
	phonePlaceholder: "手机号",
	passwordPlaceholder: "密码（在讯飞账号中心设置）",
	signInSubmit: "登录",
	signInDone: "登录成功，拉取模型目录中…",
	signInHint: "密码只在服务端用 RSA 加密后发给讯飞账号服务；本机以 0600 权限保存，用来自动续期。",
	smsSend: "发送验证码",
	smsPlaceholder: "短信验证码",
	smsSubmit: "用验证码登录",
	smsHint: "没设密码的账号只能用短信登录一次，会话到期后需要重新验证码。",
	smsSent: "验证码已发送，填进下面的输入框。",
	sessionPlaceholder: "粘贴 loomy_web_session 会话（可选）",
	sessionSubmit: "保存会话",
	sessionHint: "粘贴会话只能撑到 14 天会话到期，且没有密码可自动续期。",
	accountNoLabel: "未命名账号",
	accountPinned: "置顶",
	accountNeedsLogin: "需要登录",
	accountPaused: "已暂停",
	accountRename: "改名",
	accountRenamePlaceholder: "备注名",
	accountPin: "置顶",
	accountUnpin: "取消置顶",
	accountPause: "暂停",
	accountResume: "恢复",
	accountDelete: "删除",
	accountRelogin: "重新登录",
	accountSetPassword: "设密码",
	accountSetPasswordPlaceholder: "补一个密码即可自动续期",
	accountSessionDays: "会话还剩 {days} 天",
	accountSessionExpired: "会话已过期",
	accountNoPassword: "无密码",
	accountDevid: "设备 {devid}",
	accountConcurrency: "{active}/{max}",
	accountPoints: "{points} 点",
	accountPointsUnknown: "点数未知",
	modelsEmpty: "模型目录是空的。",
	modelsEmptyHint: "登录一个账号后点「刷新模型」；上游没返回模型就是没有模型。",
	refreshModels: "刷新模型",
	refreshing: "刷新中…",
	selectAll: "全选",
	selectInvert: "反选",
	selectionAll: "全部模型都可用",
	selectionRestricted: "只暴露勾选的模型",
	selectionNone: "一个模型都不暴露（模型选择器里不会出现 Loomy）",
	selectionCount: "已勾选 {enabled}/{total} 个模型",
	modelVision: "视觉",
	modelReasoning: "推理",
	modelTools: "工具",
	modelContext: "上下文 {tokens}",
	modelOutput: "输出 {tokens}",
	modelLevels: "档位 {levels}",
	modelMultiplier: "x{value}",
	pointsTitle: "账号点数（上游账本）",
	pointsRefresh: "刷新点数",
	pointsRefreshing: "查询中…",
	pointsAvailable: "可用 {points}",
	pointsBalance: "永久 {points}",
	pointsDaily: "每日赠送 {points}",
	pointsChecked: "{when} 查过",
	pointsNever: "还没查过点数",
	pointsError: "查询失败：{message}",
	pointsExhaustedTag: "点数不足",
	pointsExhaustedNotice: "有 {count} 个号被上游判过点数不足，已冷却 10 分钟并换号。",
	pointsNote: "这是上游账本里的账号级点数：可用 = 永久余额 + 每日赠送。每日赠送什么时候重置由上游决定，这里不编倒计时。下面的「今日」只统计本机经这个插件花掉的量。",
	displayReadonly: "当前宿主没有可写的设置服务，开关只读。",
	showDock: "对话输入框下方的 Loomy 状态行",
	showSidebar: "侧边栏图标列里的 Loomy 入口",
	showSettings: "设置左侧导航里的 Loomy 入口",
	usageTitle: "本机用量",
	usageTodayRequests: "今日 {count} 次请求",
	usageTodayInput: "输入 {tokens} tokens",
	usageTodayOutput: "输出 {tokens} tokens",
	usageTodayPoints: "花费 {points} 点",
	usageScope: "只统计本机经本插件发出的请求，不是账号总额度",
	doctor: "体检",
	doctorOk: "体检通过：账号、会话、目录、shim 与 provider 都在。",
	doctorFail: "体检未通过：{detail}",
	strategyLabel: "选号策略",
	strategyBalance: "点数最多优先",
	strategyRoundRobin: "按顺序轮转",
	strategyLru: "最久未用优先",
	dockProvider: "Loomy",
	dockUsage: "今日 {tokens} tokens",
	dockPoints: "花费 {points} 点",
	dockNone: "还没有可用账号，点这里去登录",
	dockNeedsLogin: "{count} 个号需要登录"
};
const en = {
	tabLabel: "Loomy",
	panelTitle: "Loomy",
	backToConversation: "Back to conversation",
	cardTitle: "Loomy Connect",
	cardSubtitle: "Bridge Loomy model quota into DSH: phone number + password sign-in happens on the server and yields a 14-day session.",
	tabAccounts: "Accounts",
	tabModels: "Models",
	tabPoints: "Points",
	tabDisplay: "Display",
	statusLoading: "Loading…",
	signedOut: "No account yet",
	signedInCount: "{count} account(s)",
	versionLabel: "v{version}",
	loadFailed: "Could not load the status: {message}",
	addAccountTitle: "Add an account",
	phonePlaceholder: "Phone number",
	passwordPlaceholder: "Password (set in the iFlytek account centre)",
	signInSubmit: "Sign in",
	signInDone: "Signed in — loading the model catalog…",
	signInHint: "The password is RSA-encrypted and sent to the iFlytek account service only; it is stored locally with 0600 permissions and used for automatic renewal.",
	smsSend: "Send code",
	smsPlaceholder: "SMS code",
	smsSubmit: "Sign in with code",
	smsHint: "An account without a password can only sign in by SMS; the session cannot renew itself.",
	smsSent: "Code sent — type it below.",
	sessionPlaceholder: "Paste a loomy_web_session value (optional)",
	sessionSubmit: "Save session",
	sessionHint: "A pasted session lasts at most 14 days and cannot renew itself.",
	accountNoLabel: "Unnamed account",
	accountPinned: "Pinned",
	accountNeedsLogin: "Needs sign-in",
	accountPaused: "Paused",
	accountRename: "Rename",
	accountRenamePlaceholder: "Label",
	accountPin: "Pin",
	accountUnpin: "Unpin",
	accountPause: "Pause",
	accountResume: "Resume",
	accountDelete: "Delete",
	accountRelogin: "Sign in again",
	accountSetPassword: "Set password",
	accountSetPasswordPlaceholder: "Add a password to enable automatic renewal",
	accountSessionDays: "{days} day(s) of session left",
	accountSessionExpired: "Session expired",
	accountNoPassword: "No password",
	accountDevid: "device {devid}",
	accountConcurrency: "{active}/{max}",
	accountPoints: "{points} points",
	accountPointsUnknown: "points unknown",
	modelsEmpty: "The model catalog is empty.",
	modelsEmptyHint: "Sign an account in and press \"Refresh models\"; whatever the upstream lists is all there is.",
	refreshModels: "Refresh models",
	refreshing: "Refreshing…",
	selectAll: "Select all",
	selectInvert: "Invert",
	selectionAll: "Every model is offered",
	selectionRestricted: "Only the checked models are offered",
	selectionNone: "No model is offered (Loomy disappears from the model picker)",
	selectionCount: "{enabled}/{total} models checked",
	modelVision: "vision",
	modelReasoning: "reasoning",
	modelTools: "tools",
	modelContext: "context {tokens}",
	modelOutput: "output {tokens}",
	modelLevels: "levels {levels}",
	modelMultiplier: "x{value}",
	pointsTitle: "Account points (upstream ledger)",
	pointsRefresh: "Refresh points",
	pointsRefreshing: "Looking up…",
	pointsAvailable: "{points} available",
	pointsBalance: "{points} permanent",
	pointsDaily: "{points} daily",
	pointsChecked: "checked {when}",
	pointsNever: "points not looked up yet",
	pointsError: "lookup failed: {message}",
	pointsExhaustedTag: "Out of points",
	pointsExhaustedNotice: "{count} account(s) were rejected for points; each is cooled down for 10 minutes and skipped.",
	pointsNote: "These are the account-level points the upstream ledger reports: available = permanent balance + daily grant. The daily grant resets on the upstream side, so no countdown is invented here. \"Today\" below only counts what this machine spent through this plugin.",
	displayReadonly: "This host has no writable settings service, so the switches are read-only.",
	showDock: "Loomy status line under the chat input",
	showSidebar: "Loomy entry in the sidebar icon column",
	showSettings: "Loomy entry in the settings navigation",
	usageTitle: "Local usage",
	usageTodayRequests: "{count} request(s) today",
	usageTodayInput: "{tokens} input tokens",
	usageTodayOutput: "{tokens} output tokens",
	usageTodayPoints: "{points} points spent",
	usageScope: "Only requests sent through this plugin on this machine — not the account total",
	doctor: "Run checks",
	doctorOk: "All checks passed: accounts, sessions, catalog, shim and provider.",
	doctorFail: "A check failed: {detail}",
	strategyLabel: "Account strategy",
	strategyBalance: "Most points first",
	strategyRoundRobin: "Round robin",
	strategyLru: "Least recently used",
	dockProvider: "Loomy",
	dockUsage: "{tokens} tokens today",
	dockPoints: "{points} points spent",
	dockNone: "No account available — click to sign in",
	dockNeedsLogin: "{count} account(s) need sign-in"
};
// src/client/settings-route.ts
/**
* 打开「设置 → DevEco」这一页，不依赖宿主的私有 API。
*
* 两条路：
* 1. 新壳：设置面板在 `sidebar.settings` 槽上留了一个 store，`actions.openSection(id)` 直接开；
* 2. 老壳：先 `shortcuts.invoke('settings.open')`，再在设置弹层里点同名导航行。
*
* 两条都失败时返回 false，由调用方决定退路（卡片自己就在设置里，通常不必退）。
*
* @module dsh-loomy/client/settings-route
*/
/** 设置壳所在的槽位键。 */
const SETTINGS_SLOT = "sidebar.settings";
/** 老壳里重试点击的节奏（毫秒）。 */
const RETRY_DELAYS_MS = [
	0,
	60,
	70,
	80,
	90
];
function openViaStore(deps) {
	try {
		const entries = deps.slots?.entries?.(SETTINGS_SLOT) ?? [];
		for (const entry of entries) {
			const open = (entry.store?.create?.())?.actions?.openSection;
			if (typeof open === "function") {
				open(deps.sectionId);
				return true;
			}
		}
	} catch {}
	return false;
}
function openViaShortcut(deps) {
	const invoke = deps.shortcuts?.invoke;
	if (typeof invoke !== "function") return false;
	const doc = deps.doc ?? (typeof document === "undefined" ? void 0 : document);
	if (doc === void 0) return false;
	const schedule = deps.schedule ?? ((run, ms) => {
		setTimeout(run, ms).unref?.();
	});
	const wanted = (deps.label?.() ?? deps.sectionId).trim();
	invoke("settings.open", { modal: null });
	for (const delay of RETRY_DELAYS_MS) schedule(() => {
		const row = [...(doc.querySelector("[data-shortcut-modal=\"settings\"]") ?? doc).querySelectorAll("[role=\"tab\"], button, [role=\"menuitem\"]")].find((element) => (element.textContent ?? "").trim() === wanted);
		if (row instanceof HTMLElement) row.click();
	}, delay);
	return true;
}
/** 尽力打开设置里的 DevEco 分节；两条路都不通时返回 false。 */
function openPluginSettings(deps) {
	return openViaStore(deps) || openViaShortcut(deps);
}
// src/client/index.tsx
/** 卡片文案的命名空间。 */
const NAMESPACE = "settings.loomy";
/** 侧边栏图标与 `main` 面板共用的 key。 */
const PANEL_ID = "dsh-loomy";
const name = "dsh-loomy-client";
const inject = ["slots", "locale"];
function apply(ctx) {
	try {
		ctx.effect(() => ctx.locale.register(NAMESPACE, {
			zh,
			en
		}), "dsh-loomy: settings copy");
		const t = ctx.locale.bind(NAMESPACE);
		ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
			name: "plugins.bundle.config",
			key: "dsh-loomy",
			locale: NAMESPACE
		}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoomyPluginCard, { t })));
		const layout = ctx.get("layout");
		const shortcuts = ctx.get("shortcuts");
		const openSettings = () => openPluginSettings({
			slots: ctx.get("slots"),
			shortcuts,
			sectionId: PANEL_ID,
			label: () => t("tabLabel")
		});
		try {
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "loomy-dock",
				order: 30,
				locale: NAMESPACE,
				inject: () => ({
					t,
					zone: "bar",
					onOpenSettings: openSettings
				})
			}, LoomyDock));
		} catch (error) {
			console.warn("[dsh-loomy] conversation dock slot unavailable:", error);
		}
		const panelClaims = [];
		const syncPanel = () => {
			for (const claim of panelClaims.splice(0)) try {
				claim();
			} catch {}
			if (!sidebarPanelWanted()) return;
			panelClaims.push(ctx.slots.inject("sidebar.panellist", () => {
				try {
					return ctx.slots.register({
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 50,
						label: () => t("tabLabel"),
						locale: NAMESPACE
					}, LoomyPanelIcon);
				} catch (error) {
					console.warn("[dsh-loomy] sidebar icon registration failed:", error);
					return () => {};
				}
			}));
			panelClaims.push(ctx.slots.inject("main", () => {
				try {
					return ctx.slots.register({
						name: "main",
						key: PANEL_ID,
						locale: NAMESPACE,
						inject: () => ({
							t,
							backToConversation: () => layout?.selectPanel?.(null)
						})
					}, LoomyPanelPage);
				} catch (error) {
					console.warn("[dsh-loomy] sidebar page registration failed:", error);
					return () => {};
				}
			}));
		};
		const settingsClaims = [];
		const syncSettingsEntry = () => {
			for (const claim of settingsClaims.splice(0)) try {
				claim();
			} catch {}
			if (!settingsEntryWanted()) return;
			settingsClaims.push(ctx.slots.inject("settings.section", () => {
				try {
					return ctx.slots.register({
						name: "settings.section",
						id: PANEL_ID,
						order: 50,
						label: () => t("tabLabel"),
						locale: NAMESPACE,
						inject: () => ({ t })
					}, LoomyPluginCard);
				} catch (error) {
					console.warn("[dsh-loomy] settings section registration failed:", error);
					return () => {};
				}
			}));
		};
		syncPanel();
		syncSettingsEntry();
		ctx.effect(() => {
			const offPanel = subscribeSidebarPanelWanted(syncPanel);
			const offSettings = subscribeSettingsEntryWanted(syncSettingsEntry);
			return () => {
				offPanel();
				offSettings();
				for (const claim of panelClaims.splice(0)) claim();
				for (const claim of settingsClaims.splice(0)) claim();
			};
		}, "dsh-loomy: navigation entries");
		(async () => {
			try {
				const response = await fetch("/api/loomy/dock", { headers: { Accept: "application/json" } });
				if (!response.ok) return;
				const data = await response.json();
				setSidebarPanelWanted(data.dock?.sidebar === true);
				setSettingsEntryWanted(data.dock?.settingsEntry !== false);
			} catch {}
		})();
	} catch (error) {
		console.error("[dsh-loomy] client card failed to load (host provider unaffected):", error);
	}
}
exports.apply = apply;
exports.inject = inject;
exports.name = name;

    return module.exports;
  }
});
