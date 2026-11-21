import { i as lazyApi, r as createProvider } from "./models-7mxFy0wO.mjs";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { constants, createHash, createHmac, createPublicKey, publicEncrypt, randomUUID, randomUUID as randomUUID$1 } from "node:crypto";
import { createServer } from "node:http";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import * as settingsModule from "@deepseek-ai/dsh-settings";
// src/config.ts
/** 模型网关（OpenAI 兼容）。 */
const LOOMY_MODEL_BASE = "https://loomyad.xunfei.cn/api/v1";
/** 账号服务（登录/用户信息）。 */
const LOOMY_ACCOUNT_BASE = "https://account.xfinfr.com";
/** 账号服务要求的 appid（客户端写死）。 */
const LOOMY_ACCOUNT_APPID = "GM3LOOMY";
/**
* 账号服务的签名常量：官方客户端在 `resources/.env.prod` 里随安装包一起分发，
* 本质是混淆而非保密。换客户端版本时可能失效，可用环境变量覆盖。
*/
const LOOMY_ACCESS_KEY_ID = "2thryby66wxi53sk";
const LOOMY_ACCESS_KEY_SECRET = "zsak6eadrbawz683wf5r3m2snrwj868r";
const LOOMY_ENVELOPE_VERSION = "1.0.0";
const LOOMY_CLIENT_UA = "Loomy|Desktop|Electron|macOS";
/** 促销设备的 id 前缀（只出现在 `/points/*` 的 body 里，聊天请求不带）。 */
const LOOMY_CAMPUS_DEVICE_PREFIX = "loomy-campus-";
/** 客户端登录时显式申请的会话寿命：14 天，且**没有** refresh token。 */
const SESSION_EXPIRE_SECONDS = 1209600;
/** 会话总寿命（毫秒）。 */
const SESSION_TTL_MS = SESSION_EXPIRE_SECONDS * 1e3;
/** 重登失败后的冷却，避免每个请求都去打登录接口。 */
const LOGIN_COOLDOWN_MS = 6e4;
/** 等上游开流时的空闲上限：沉默这么久才判死（不能用总时长超时）。 */
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 12e4;
/** 账号服务路径。 */
const ACCOUNT_PATHS = {
	publicKey: "/login/account/getPuKey",
	loginByPassword: "/login/account/byPwd",
	sendSms: "/login/phone/sendMsgCode",
	loginBySms: "/login/phone/checkCode",
	logout: "/login/account/logout",
	baseInfo: "/userinfo/query/baseInfo"
};
/** 模型网关路径。 */
const MODEL_PATHS = {
	models: "/models",
	chat: "/chat/completions",
	points: "/points/records"
};
/** 环境变量读取（空串视作未设置）。 */
function envText(name, fallback) {
	const raw = process.env[name];
	if (raw === void 0 || raw.trim() === "") return fallback;
	return raw.trim();
}
/** 环境变量读取（数字）。 */
function envNumber(name, fallback) {
	const raw = process.env[name];
	if (raw === void 0 || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}
/** 账号服务基地址（可用 `LOOMY_ACCOUNT_BASE` 覆盖，测试打本地假上游）。 */
function accountBase() {
	return envText("LOOMY_ACCOUNT_BASE", LOOMY_ACCOUNT_BASE).replace(/\/$/, "");
}
/** 模型网关基地址（可用 `LOOMY_UPSTREAM` 覆盖）。 */
function modelBase() {
	return envText("LOOMY_UPSTREAM", LOOMY_MODEL_BASE).replace(/\/$/, "");
}
/** 签名常量（客户端缺省值，可用 `LOOMY_AK_ID` / `LOOMY_AK_SECRET` 覆盖）。 */
function accessKey() {
	return {
		id: envText("LOOMY_AK_ID", LOOMY_ACCESS_KEY_ID),
		secret: envText("LOOMY_AK_SECRET", LOOMY_ACCESS_KEY_SECRET)
	};
}
/**
* 把请求里的模型 id 还原成上游 wire id。
*
* 上游用**原样的 id**，我们不建别名表；只剥掉客户端可能带上的 `imodel/` 前缀
* （客户端 provider 名），这是唯一的改写。
*/
function upstreamModelId(id) {
	const trimmed = id.trim();
	const slash = trimmed.indexOf("/");
	if (slash > 0) {
		const prefix = trimmed.slice(0, slash);
		if (prefix === "imodel" || prefix === "loomy" || prefix === "loomyad") return trimmed.slice(slash + 1);
	}
	return trimmed;
}
/** 对外暴露的模型 id：与 wire id 相同（上游目录就是真名）。 */
function exposedModelId(id) {
	return upstreamModelId(id);
}
// src/rsa.ts
/**
* 密码的 RSA 加密（账号服务 `byPwd` 路径）。
*
* 上游 `getPuKey` 给的是**裸 DER 的 RSA 公钥**（base64）。客户端用 RSA/PKCS#1 v1.5
* 加密密码再提交，服务端私钥解出来对照。这里不手写大数运算 —— `node:crypto` 的
* `publicEncrypt` + `RSA_PKCS1_PADDING` 就是同一件事。
*
* 两个坑：
*
* 1. DER 可能是 SubjectPublicKeyInfo（`30 30 … 03 … 02`），也可能是裸 PKCS#1
*    （`30 … 02 … 02`）。两种都试，不要假定。
* 2. 密码长度超过 `k - 11` 字节时 PKCS#1 v1.5 直接失败 —— 错误要说人话，别把
*    `data too large for key size` 丢给用户。
*
* @module dsh-loomy/rsa
*/
/** 一条看起来像 base64 但缺 padding 的公钥也接受（Node 的 base64 解码会忽略尾部）。 */
function decodeBase64(value) {
	const trimmed = value.trim();
	if (trimmed === "") throw new Error("the account service returned an empty public key");
	return Buffer.from(trimmed, "base64");
}
/** 把 base64 DER 变成可用的公钥对象；SPKI / PKCS#1 都试。 */
function publicKeyFromDer(derBase64) {
	const der = decodeBase64(derBase64);
	const attempts = [{ type: "spki" }, { type: "pkcs1" }];
	let lastError;
	for (const attempt of attempts) try {
		return createPublicKey({
			key: der,
			format: "der",
			type: attempt.type
		});
	} catch (error) {
		lastError = error;
	}
	throw new Error(`could not parse the RSA public key from the account service (${lastError instanceof Error ? lastError.message : String(lastError)})`);
}
/** 按 PKCS#1 v1.5 加密明文（密码），返回 base64 密文。 */
function rsaEncrypt(derBase64, plaintext) {
	const key = publicKeyFromDer(derBase64);
	const details = key.asymmetricKeyDetails;
	const modulusBytes = details?.modulusLength === void 0 ? 0 : Math.ceil(details.modulusLength / 8);
	const message = Buffer.from(plaintext, "utf8");
	if (modulusBytes > 0 && message.length > modulusBytes - 11) throw new Error(`the password is too long for the account service's RSA-${String(details?.modulusLength ?? 0)} key (at most ${String(modulusBytes - 11)} bytes)`);
	return publicEncrypt({
		key,
		padding: constants.RSA_PKCS1_PADDING
	}, message).toString("base64");
}
// src/signer.ts
/**
* 讯飞账号服务的请求签名（HMAC-SHA1）。
*
* 与客户端 `electron/xfyun/sign.js` 的算法逐字对应（`docs/PROTOCOL.md` 第 3 节）：
*
* ```
* stringToSign = "\n".join([
*   METHOD, ESCAPED_PATH, ESCAPED_QUERY, Content-MD5,
*   Content-Type, Date, Nonce, SignedHeaders, CanonicalizedHeaders,
* ])
* signature     = base64(hmac_sha1(accessKeySecret, stringToSign))
* Authorization = "account <accessKeyId>:<signature>"
* ```
*
* **九行，不是七行**：没有自定义 `x-*` 头时最后两行是空串，但必须存在 —— 少一行就是
* `HMAC signature does not match`，而这个错误完全看不出是行数问题。
*
* @module dsh-loomy/signer
*/
/** RFC 3986 保留字符：`encodeURIComponent` 留着它们，服务端却要转义。 */
const EXTRA_ESCAPES = {
	"!": "%21",
	"'": "%27",
	"(": "%28",
	")": "%29",
	"*": "%2A"
};
/** `encodeURIComponent` 的 safe 集是 `-_.!~*'()`，这里收窄到 `-_.~` 再补转义。 */
function escape(value) {
	return encodeURIComponent(value).replace(/[!'()*]/g, (character) => EXTRA_ESCAPES[character] ?? character);
}
/** `base64(md5(body))`；空 body 是空串（不是空 md5）。 */
function contentMd5(body) {
	if (body === "") return "";
	return createHash("md5").update(body, "utf8").digest("base64");
}
/** 逐段转义路径（`/a/b` → `/a/b`，段内的保留字符才转义）。 */
function escapedPath(path) {
	let value = path.startsWith("/") ? path : `/${path}`;
	if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
	return value.split("/").map((segment) => segment === "" ? "" : escape(segment)).join("/");
}
/** 转义查询串（按传入顺序，与签名一致）。 */
function escapedQuery(params = {}) {
	const entries = Object.entries(params).filter(([, value]) => value !== void 0);
	if (entries.length === 0) return "";
	return entries.map(([key, value]) => `${escape(key)}=${escape(value === void 0 ? "" : String(value))}`).join("&");
}
/** 自定义头里的 `x-*`：排序后的名字与规范化的 `k:v\n` 行。 */
function canonicalized(customHeaders = {}) {
	const picked = {};
	for (const [key, value] of Object.entries(customHeaders)) {
		const lower = key.toLowerCase();
		if (lower.startsWith("x-")) picked[lower] = String(value).trim();
	}
	const keys = Object.keys(picked).sort();
	if (keys.length === 0) return {
		signed: "",
		canonical: ""
	};
	return {
		signed: keys.join(";"),
		canonical: keys.map((key) => `${key}:${picked[key]}\n`).join("").replace(/\n$/, "")
	};
}
/** 待签名的九行文本。导出给测试逐行比对。 */
function stringToSign(input) {
	const { signed, canonical } = canonicalized(input.customHeaders);
	return [
		input.method.toUpperCase(),
		escapedPath(input.path),
		escapedQuery(input.query),
		contentMd5(input.body ?? ""),
		input.contentType ?? "application/json",
		input.date,
		input.nonce,
		signed,
		canonical
	].join("\n");
}
/** HMAC-SHA1 签名（base64）。 */
function sign(secret, input) {
	return createHmac("sha1", secret).update(stringToSign(input), "utf8").digest("base64");
}
/** HTTP 日期（GMT，`Sat, 26 Sep 2026 12:00:00 GMT` 形态）。 */
function httpDate(at = /* @__PURE__ */ new Date()) {
	return at.toUTCString();
}
/**
* 一次账号服务请求的完整头集合。
*
* `Content-MD5` 只在有 body 时出现 —— 但签名里的那一行**永远**存在（空串）。
*/
function buildAccountHeaders(options) {
	const body = options.body ?? "";
	const contentType = options.contentType ?? "application/json";
	const date = httpDate(options.now);
	const nonce = options.nonce ?? randomUUID$1();
	const signature = sign(options.accessKeySecret, {
		method: options.method,
		path: options.path,
		...options.query === void 0 ? {} : { query: options.query },
		body,
		contentType,
		date,
		nonce,
		...options.customHeaders === void 0 ? {} : { customHeaders: options.customHeaders }
	});
	const headers = {
		Authorization: `account ${options.accessKeyId}:${signature}`,
		Date: date,
		Nonce: nonce,
		"Content-Type": contentType
	};
	const md5 = contentMd5(body);
	if (md5 !== "") headers["Content-MD5"] = md5;
	for (const [key, value] of Object.entries(options.customHeaders ?? {})) headers[key] = String(value);
	return headers;
}
// src/login.ts
/**
* 讯飞账号服务客户端：登录（密码 / 短信）、用户信息、登出。
*
* 与 DevEco 那种「浏览器授权 + 本机回环回调」完全不同，这里是**服务端直接登录**：
*
* ```
* POST /login/account/getPuKey   → {pukey, rcode}   rcode 是服务端 nonce，不是验证码
* POST /login/account/byPwd      → {session, userid, phone}
* ```
*
* 密码用 `pukey` 做 RSA/PKCS#1 v1.5 加密，请求本身用客户端常量签名（`signer.ts`）。
* 登录换来的是 **14 天会话**，模型网关把它当 Bearer 用；上游**不发 refresh token**，
* 所以续期的唯一办法就是拿存着的密码再登一次 —— 这也是为什么账号必须存密码才能无人值守。
*
* 短信登录（`sendMsgCode` → `checkCode`）只是为了在「还没设密码」的账号上拿到一次会话；
* 验证码要人读，所以它不适合当日常续期手段。
*
* @module dsh-loomy/login
*/
/** 带分类的登录错误。 */
var LoginError = class extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.name = "LoginError";
		this.kind = kind;
	}
};
/** 造一个设备标识。 */
function newIdentity(mode = "per_account", now = Date.now()) {
	if (mode === "client") return {
		devid: "web",
		ua: LOOMY_CLIENT_UA,
		modelid: "Web",
		version: LOOMY_ENVELOPE_VERSION,
		createdAt: now
	};
	return {
		devid: `web-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
		ua: LOOMY_CLIENT_UA,
		modelid: "Web",
		version: LOOMY_ENVELOPE_VERSION,
		campusDeviceId: `${LOOMY_CAMPUS_DEVICE_PREFIX}${randomUUID()}`,
		createdAt: now
	};
}
/** 32 位十六进制 trace id。 */
function traceId() {
	return randomUUID().replace(/-/g, "");
}
/** 从上游响应里抠出可读文本。 */
function errorText(payload, status) {
	for (const key of [
		"desc",
		"message",
		"msg",
		"error"
	]) {
		const value = payload[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return `HTTP ${status}`;
}
function isObject$4(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* 账号服务客户端。
*
* `call()` 是所有路径的唯一出口：签名、信封、错误归类都在这里，别在别处再拼一次。
*/
var AccountService = class {
	baseUrl;
	akId;
	akSecret;
	timeoutMs;
	fetchImpl;
	constructor(options = {}) {
		const keys = accessKey();
		this.baseUrl = (options.baseUrl ?? accountBase()).replace(/\/$/, "");
		this.akId = options.accessKeyId ?? keys.id;
		this.akSecret = options.accessKeySecret ?? keys.secret;
		this.timeoutMs = options.timeoutMs ?? 2e4;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}
	/** 请求信封的 `base` 字段。 */
	envelope(identity) {
		return {
			appid: LOOMY_ACCOUNT_APPID,
			modelid: identity?.modelid ?? "Web",
			version: identity?.version ?? "1.0.0",
			devid: identity?.devid ?? "web",
			ua: identity?.ua ?? "Loomy|Desktop|Electron|macOS",
			traceid: traceId()
		};
	}
	/**
	* 发一个账号服务请求。
	*
	* body 为空时**不带** `Content-Type` 之外的 body，也不带 `Content-MD5`，
	* 但签名里的那一行仍然是空串（见 `signer.ts`）。
	*/
	async call(path, body, options = {}) {
		const payload = body === void 0 ? "" : JSON.stringify({
			base: this.envelope(options.identity),
			...body
		});
		const headers = buildAccountHeaders({
			accessKeyId: this.akId,
			accessKeySecret: this.akSecret,
			method: "POST",
			path,
			body: payload
		});
		headers["User-Agent"] = LOOMY_CLIENT_UA;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
		timer.unref?.();
		options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
		let response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method: "POST",
				headers,
				...payload === "" ? {} : { body: payload },
				signal: controller.signal
			});
		} catch (error) {
			throw new LoginError("network", `account service unreachable: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			clearTimeout(timer);
		}
		const text = await response.text().catch(() => "");
		let parsed = {};
		if (text.trim() !== "") try {
			const value = JSON.parse(text);
			if (isObject$4(value)) parsed = value;
		} catch {
			throw new LoginError("server", `account service returned HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
		const code = typeof parsed.code === "string" ? parsed.code : String(parsed.errorCode ?? "");
		if (code !== "" && code !== "000000") throw new LoginError(code.startsWith("1000") ? "network" : "server", `${path} failed: ${errorText(parsed, response.status)} (code ${code})`);
		if (!response.ok) throw new LoginError(response.status >= 500 ? "network" : "server", `${path} failed with HTTP ${response.status}: ${errorText(parsed, response.status)}`);
		return parsed;
	}
	/** `pukey`（base64 DER）与 `rcode`（服务端 nonce）。 */
	async getPublicKey(options = {}) {
		const payload = await this.call(ACCOUNT_PATHS.publicKey, {}, options);
		const data = isObject$4(payload.data) ? payload.data : payload;
		const pukey = typeof data.pukey === "string" ? data.pukey : "";
		const rcode = typeof data.rcode === "string" ? data.rcode : "";
		if (pukey === "") throw new LoginError("server", "getPuKey returned no public key");
		return {
			pukey,
			rcode
		};
	}
	/** 手机号 + 密码登录。 */
	async loginByPassword(loginid, password, options = {}) {
		const phone = loginid.trim();
		if (phone === "") throw new LoginError("credentials", "the phone number is required");
		if (password === "") throw new LoginError("credentials", "the password is required");
		const { pukey, rcode } = await this.getPublicKey(options);
		let encrypted;
		try {
			encrypted = rsaEncrypt(pukey, password);
		} catch (error) {
			throw new LoginError("credentials", error instanceof Error ? error.message : String(error));
		}
		return readLoginResult(await this.call(ACCOUNT_PATHS.loginByPassword, { param: {
			loginid: phone,
			password: encrypted,
			rcode,
			type: 1,
			expire: SESSION_EXPIRE_SECONDS
		} }, options), phone);
	}
	/** 发短信验证码，返回 `msgid`（下一步要用）。 */
	async sendSmsCode(phone, options = {}) {
		const payload = await this.call(ACCOUNT_PATHS.sendSms, { param: {
			ccode: "86",
			phone: phone.trim(),
			expire: 300
		} }, options);
		const data = isObject$4(payload.data) ? payload.data : payload;
		const msgid = typeof data.msgid === "string" ? data.msgid : "";
		if (msgid === "") throw new LoginError("sms", "sendMsgCode returned no msgid");
		return msgid;
	}
	/** 用验证码换会话。 */
	async loginBySms(phone, code, msgid, options = {}) {
		return readLoginResult(await this.call(ACCOUNT_PATHS.loginBySms, { param: {
			ccode: "86",
			phone: phone.trim(),
			mcode: code.trim(),
			msgid,
			expire: SESSION_EXPIRE_SECONDS
		} }, options), phone);
	}
	/** 用户信息（会话是否还有效的旁证）。 */
	async baseInfo(session, options = {}) {
		const payload = await this.call(ACCOUNT_PATHS.baseInfo, { param: { session } }, options);
		return isObject$4(payload.data) ? payload.data : payload;
	}
	/** 主动登出（删账号时尽力调用，失败不影响本地删除）。 */
	async logout(session, options = {}) {
		await this.call(ACCOUNT_PATHS.logout, { param: { session } }, options);
	}
};
/** 从登录响应里取 `session` / `userid` / `phone`，形状不对就报清楚。 */
function readLoginResult(payload, fallbackPhone) {
	const node = isObject$4(payload.data) ? payload.data : payload;
	const session = typeof node.session === "string" ? node.session : "";
	if (session === "") throw new LoginError("credentials", "the account service accepted the login but returned no session");
	const userid = typeof node.userid === "string" ? node.userid : typeof node.userId === "string" ? node.userId : void 0;
	const phone = typeof node.phone === "string" && node.phone !== "" ? node.phone : fallbackPhone;
	const obtainedAt = Date.now();
	return {
		session,
		...userid === void 0 || userid === "" ? {} : { userid },
		...phone === "" ? {} : { phone },
		obtainedAt,
		expireAt: obtainedAt + SESSION_TTL_MS
	};
}
/** 账号在文档里的自然键：`userid` → 手机号 → 会话哈希。 */
function accountKeyOf(account) {
	if (account.userid !== void 0 && account.userid !== "") return account.userid;
	if (account.loginid !== void 0 && account.loginid !== "") return account.loginid;
	const seed = account.session ?? "";
	return `s${createHash("sha256").update(seed).digest("hex").slice(0, 15)}`;
}
/** 手机号打码（`138****0000`），卡片上不印完整号码。 */
function maskPhone(phone) {
	if (phone === void 0) return void 0;
	const trimmed = phone.trim();
	if (trimmed.length < 7) return trimmed === "" ? void 0 : trimmed;
	return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}
// src/accounts.ts
/**
* Loomy 账号文档 + 会话生命周期。
*
* 上游只发**一种**凭证：登录换来的 14 天会话（`docs/PROTOCOL.md` 第 2 节）。它同时是
* 账号服务和模型网关的 Bearer；**没有 refresh token**。所以凭证的生命周期只有一条路：
* 快过期就拿存着的手机号+密码再登一次。
*
* | 情况 | 处理 |
* |---|---|
* | 有密码、会话有效 | 直接用 |
* | 有密码、会话快过期（< 3 天） | 静默重登（单飞 + 代际） |
* | 有密码、会话已失效 | 重登；失败进冷却，不把账号写成死号 |
* | 没密码（粘贴会话） | 到期或被上游 401 → 标 `needsLogin`，等用户重新粘贴 |
*
* 单飞是必须的：同一账号并发重登会互相覆盖会话，后到的那次还可能把刚换好的会话当成
* 「旧值」写回去。代际计数负责「期间有没有人登录过」。
*
* @module dsh-loomy/accounts
*/
/** 数据目录：默认 `~/.dsh`（与宿主一致），可用 `DSH_HOME` 覆盖。 */
function loomyHome(home) {
	return home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/** 多账号文档路径。 */
function loomyAccountsPath(home) {
	return join(loomyHome(home), ".loomy-accounts.json");
}
/** 用量台账路径。 */
function loomyUsagePath(home) {
	return join(loomyHome(home), ".loomy-usage.json");
}
/** 登录/续期失败日志路径（宿主对插件 debug 日志没有出口，失败原因只能自己留档）。 */
function loomyRefreshLogPath(home) {
	return join(loomyHome(home), ".loomy-refresh.log");
}
/** 原子写 JSON（临时文件 + rename），并尽力收紧到 0600。 */
function writeJsonAtomic(path, value) {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, void 0, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	renameSync(temp, path);
	try {
		chmodSync(path, 384);
	} catch {}
}
function readJsonFile(path) {
	try {
		if (!existsSync(path)) return void 0;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
/** 会话剩余寿命（毫秒）；没有会话或已过期 ≤ 0。 */
function sessionRemainingMs(account, now = Date.now()) {
	if (typeof account.session !== "string" || account.session === "") return 0;
	const expireAt = account.expireAt;
	if (typeof expireAt !== "number" || !Number.isFinite(expireAt) || expireAt <= 0) return SESSION_TTL_MS;
	return expireAt - now;
}
/** 账号能不能被派活（不暂停、不待登录）。 */
function accountDispatchable(account) {
	if (account.paused === true) return false;
	if (account.needsLogin === true) return false;
	return true;
}
/** 生成一条账号摘要。 */
function summarizeAccount(id, account, now = Date.now()) {
	const remaining = sessionRemainingMs(account, now);
	const usable = account.needsLogin !== true && remaining > 0;
	return {
		id,
		...account.label === void 0 ? {} : { label: account.label },
		...account.loginid === void 0 ? {} : { loginid: maskPhone(account.loginid) },
		...account.userid === void 0 ? {} : { userid: account.userid },
		hasPassword: typeof account.password === "string" && account.password !== "",
		usable,
		needsLogin: account.needsLogin === true || remaining <= 0,
		...account.expireAt === void 0 ? {} : { sessionExpiresAt: account.expireAt },
		...remaining > 0 ? { sessionDaysLeft: Math.round(remaining / 864e5 * 10) / 10 } : {},
		devid: account.identity?.devid ?? "",
		paused: account.paused === true,
		pinned: account.pinned === true,
		...account.storedAt === void 0 ? {} : { storedAt: account.storedAt },
		...account.lastLoginAt === void 0 ? {} : { lastLoginAt: account.lastLoginAt },
		...account.source === void 0 ? {} : { source: account.source }
	};
}
/**
* 一个账号的运行时外壳：会话解析 + 单飞重登。
*
* 它不改文档，只把「新的账号记录」通过 `persist` 交回去 —— 谁拥有文档谁落盘。
*/
var AccountSlot = class {
	account;
	inflight;
	generation = 0;
	blockedUntil = 0;
	service;
	persist;
	log;
	constructor(account, service, persist, log) {
		this.account = account;
		this.service = service;
		this.persist = persist;
		this.log = log;
	}
	current() {
		return this.account;
	}
	/** 外部改了文档（重新登录/改备注/暂停）时同步进来。 */
	replace(account) {
		this.account = account;
		this.generation += 1;
		this.blockedUntil = 0;
	}
	/** 能否用密码自动续期。 */
	canRelogin() {
		return typeof this.account.loginid === "string" && this.account.loginid !== "" && typeof this.account.password === "string" && this.account.password !== "";
	}
	/**
	* 要一个可用的会话。
	*
	* @returns 会话；确实需要人工重新登录时 undefined（并已把账号标成 needsLogin）。
	*/
	async session() {
		const remaining = sessionRemainingMs(this.account);
		const hasSession = typeof this.account.session === "string" && this.account.session !== "";
		const rejected = this.account.needsLogin === true;
		if (!rejected && hasSession && remaining > 2592e5) return this.account.session;
		if (!this.canRelogin()) {
			if (!rejected && hasSession && remaining > 0) return this.account.session;
			this.markNeedsLogin("the session expired and this account has no stored password");
			return;
		}
		if (Date.now() < this.blockedUntil) return !rejected && remaining > 0 ? this.account.session : void 0;
		this.inflight ??= this.relogin().finally(() => {
			this.inflight = void 0;
		});
		const outcome = await this.inflight;
		if (outcome !== void 0) return outcome;
		return sessionRemainingMs(this.account) > 0 ? this.account.session : void 0;
	}
	/** 强制重登一次（卡片「重新登录」/ 401 之后）。 */
	async forceRelogin() {
		if (!this.canRelogin()) return false;
		this.inflight ??= this.relogin(true).finally(() => {
			this.inflight = void 0;
		});
		return await this.inflight !== void 0;
	}
	async relogin(force = false) {
		const generation = this.generation;
		const loginid = this.account.loginid ?? "";
		const password = this.account.password ?? "";
		try {
			const result = await this.service.loginByPassword(loginid, password, { identity: this.account.identity });
			if (generation !== this.generation) return this.account.session;
			const next = applyLoginResult(this.account, result);
			this.account = next;
			this.generation += 1;
			this.blockedUntil = 0;
			this.persist(next);
			return result.session;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (generation === this.generation) {
				this.blockedUntil = Date.now() + LOGIN_COOLDOWN_MS;
				this.log?.(`renewal failed for ${loginid === "" ? "account" : maskPhone(loginid) ?? loginid}: ${message}`);
				const hard = error instanceof LoginError && error.kind === "credentials";
				const stillValid = sessionRemainingMs(this.account) > 0;
				if (hard && !stillValid || force) this.markNeedsLogin(message);
			}
			return;
		}
	}
	markNeedsLogin(reason) {
		if (this.account.needsLogin === true) return;
		this.account = {
			...this.account,
			needsLogin: true
		};
		this.generation += 1;
		this.persist(this.account);
		this.log?.(`account marked needs-login: ${reason}`);
	}
	/** 上游明确否定了这个会话（401/403）。 */
	noteRejected(reason) {
		if (this.canRelogin()) {
			this.account = {
				...this.account,
				needsLogin: false,
				expireAt: Date.now()
			};
			this.generation += 1;
			this.persist(this.account);
			this.blockedUntil = 0;
			this.log?.(`session rejected (${reason}); will sign in again with the stored password`);
			return;
		}
		this.markNeedsLogin(reason);
	}
};
/** 把一次登录结果合进账号记录。 */
function applyLoginResult(account, result) {
	return {
		...account,
		session: result.session,
		obtainedAt: result.obtainedAt,
		expireAt: result.expireAt,
		lastLoginAt: result.obtainedAt,
		needsLogin: false,
		...result.userid === void 0 || result.userid === "" ? {} : { userid: result.userid },
		...result.phone === void 0 || result.phone === "" ? {} : { loginid: account.loginid ?? result.phone }
	};
}
/**
* 多账号文档。
*
* 文档只管「存了什么」，能不能接活由池（`account-pool.ts`）决定；会话解析在这一层，
* 因为单飞必须按账号做，而池不该碰凭证。
*/
var LoomyAccountStore = class {
	path;
	service;
	identityMode;
	log;
	now;
	document;
	loading;
	slots = /* @__PURE__ */ new Map();
	constructor(path, options = {}) {
		this.path = path;
		this.service = options.service ?? new AccountService();
		this.identityMode = options.identityMode ?? "per_account";
		this.log = options.log;
		this.now = options.now ?? (() => Date.now());
	}
	/** 当前磁盘路径（部署/诊断用）。 */
	get documentPath() {
		return this.path;
	}
	/** 账号服务客户端（卡片「发送验证码」也要用）。 */
	get accountService() {
		return this.service;
	}
	async ensureLoaded() {
		if (this.document !== void 0) return;
		this.loading ??= this.load();
		await this.loading;
	}
	async load() {
		const raw = readJsonFile(this.path);
		const accounts = {};
		for (const [id, value] of Object.entries(raw?.accounts ?? {})) {
			if (value === null || typeof value !== "object") continue;
			const account = value;
			const hasSession = typeof account.session === "string" && account.session !== "";
			const hasPassword = typeof account.password === "string" && account.password !== "";
			if (!hasSession && !hasPassword) continue;
			accounts[id] = {
				...account,
				identity: account.identity ?? newIdentity(this.identityMode, this.now())
			};
		}
		const order = Array.isArray(raw?.order) ? raw.order.filter((id) => typeof id === "string" && accounts[id] !== void 0) : [];
		for (const id of Object.keys(accounts)) if (!order.includes(id)) order.push(id);
		this.document = {
			version: 1,
			order,
			accounts
		};
	}
	get doc() {
		this.document ??= {
			version: 1,
			order: [],
			accounts: {}
		};
		return this.document;
	}
	flush() {
		writeJsonAtomic(this.path, this.doc);
	}
	slot(id, account) {
		const existing = this.slots.get(id);
		if (existing !== void 0) return existing;
		const slot = new AccountSlot(account, this.service, (next) => {
			this.doc.accounts[id] = next;
			this.flush();
		}, this.log);
		this.slots.set(id, slot);
		return slot;
	}
	/** 账号摘要列表（按文档顺序）。 */
	async list() {
		await this.ensureLoaded();
		const doc = this.doc;
		return doc.order.map((id) => {
			const account = doc.accounts[id];
			return account === void 0 ? void 0 : summarizeAccount(id, account, this.now());
		}).filter((entry) => entry !== void 0);
	}
	/** 账号 id 列表（文档顺序）。 */
	async ids() {
		await this.ensureLoaded();
		return [...this.doc.order];
	}
	/** 能参与轮转的账号 id（排除暂停与待登录）。 */
	async dispatchIds() {
		await this.ensureLoaded();
		const doc = this.doc;
		return doc.order.filter((id) => {
			const account = doc.accounts[id];
			return account !== void 0 && accountDispatchable(account);
		});
	}
	/** 某个账号的记录副本。 */
	async account(id) {
		await this.ensureLoaded();
		const account = this.doc.accounts[id];
		return account === void 0 ? void 0 : { ...account };
	}
	/** 有没有任何账号。 */
	async hasAny() {
		return (await this.ids()).length > 0;
	}
	/** 写入/更新一个账号，返回账号 id。 */
	async upsert(account, id) {
		await this.ensureLoaded();
		const doc = this.doc;
		const key = id ?? accountKeyOf(account);
		const previous = doc.accounts[key];
		const next = {
			...account,
			identity: account.identity ?? newIdentity(this.identityMode, this.now()),
			storedAt: previous?.storedAt ?? account.storedAt ?? this.now(),
			...previous?.label === void 0 ? {} : { label: account.label ?? previous.label },
			...previous?.paused === void 0 ? {} : { paused: previous.paused },
			...previous?.pinned === void 0 ? {} : { pinned: previous.pinned }
		};
		doc.accounts[key] = next;
		if (!doc.order.includes(key)) doc.order.push(key);
		this.slots.get(key)?.replace(next);
		this.flush();
		return key;
	}
	/**
	* 用手机号+密码登录并落库。
	*
	* 手机号就是自然键（同一个号重新登录不该多出一条记录）；但如果这个号已经有一条
	* `userid` 不同的记录，就按 `userid` 合并 —— 换个手机号登录同一个账号也不会重复。
	*/
	async signInWithPassword(options) {
		await this.ensureLoaded();
		const phone = options.loginid.trim();
		const existingId = options.id ?? await this.findByPhone(phone);
		const identity = existingId === void 0 ? newIdentity(this.identityMode, this.now()) : this.doc.accounts[existingId]?.identity ?? newIdentity(this.identityMode, this.now());
		const result = await this.service.loginByPassword(phone, options.password, { identity });
		const merged = applyLoginResult({
			loginid: phone,
			password: options.password,
			identity,
			source: "password",
			...options.label === void 0 || options.label.trim() === "" ? {} : { label: options.label.trim() },
			storedAt: this.now()
		}, result);
		const id = await this.upsert(merged, existingId);
		return {
			id,
			account: { ...this.doc.accounts[id] }
		};
	}
	/** 用短信验证码登录并落库（没设密码的账号只能这样拿一次会话）。 */
	async signInWithSms(options) {
		await this.ensureLoaded();
		const phone = options.loginid.trim();
		const existingId = options.id ?? await this.findByPhone(phone);
		const previous = existingId === void 0 ? void 0 : this.doc.accounts[existingId];
		const identity = previous?.identity ?? newIdentity(this.identityMode, this.now());
		const result = await this.service.loginBySms(phone, options.code, options.msgid, { identity });
		const merged = applyLoginResult({
			loginid: phone,
			...previous?.password === void 0 ? {} : { password: previous.password },
			identity,
			source: previous?.password === void 0 ? "sms" : "password",
			...options.label === void 0 || options.label.trim() === "" ? {} : { label: options.label.trim() },
			storedAt: this.now()
		}, result);
		const id = await this.upsert(merged, existingId);
		return {
			id,
			account: { ...this.doc.accounts[id] }
		};
	}
	/** 粘贴一个已有会话（没有密码，到期只能人工再来一次）。 */
	async addSession(options) {
		await this.ensureLoaded();
		const session = options.session.trim();
		const now = this.now();
		const account = {
			session,
			identity: options.id === void 0 ? newIdentity(this.identityMode, now) : this.doc.accounts[options.id]?.identity ?? newIdentity(this.identityMode, now),
			obtainedAt: now,
			expireAt: options.expireAt ?? now + 12096e5,
			source: "session",
			storedAt: now,
			...options.loginid === void 0 || options.loginid.trim() === "" ? {} : { loginid: options.loginid.trim() },
			...options.userid === void 0 || options.userid.trim() === "" ? {} : { userid: options.userid.trim() },
			...options.label === void 0 || options.label.trim() === "" ? {} : { label: options.label.trim() }
		};
		const key = options.id ?? accountKeyOf(account);
		return this.upsert(account, key);
	}
	/** 按手机号找账号 id。 */
	async findByPhone(phone) {
		await this.ensureLoaded();
		const trimmed = phone.trim();
		if (trimmed === "") return void 0;
		return this.doc.order.find((id) => this.doc.accounts[id]?.loginid === trimmed);
	}
	/** 补/改密码（粘贴会话的账号后来补了密码，就能自动续期了）。 */
	async setPassword(id, password) {
		await this.ensureLoaded();
		const account = this.doc.accounts[id];
		if (account === void 0) return false;
		const trimmed = password.trim();
		const next = trimmed === "" ? (() => {
			const { password: _dropped, ...rest } = account;
			return {
				...rest,
				source: "session"
			};
		})() : {
			...account,
			password: trimmed,
			source: "password",
			needsLogin: false
		};
		this.doc.accounts[id] = next;
		this.slots.get(id)?.replace(next);
		this.flush();
		return true;
	}
	/** 删除一个账号。 */
	async remove(id) {
		await this.ensureLoaded();
		const doc = this.doc;
		if (doc.accounts[id] === void 0) return;
		delete doc.accounts[id];
		doc.order = doc.order.filter((entry) => entry !== id);
		this.slots.delete(id);
		this.flush();
	}
	/** 清空所有账号。 */
	async clear() {
		await this.ensureLoaded();
		this.document = {
			version: 1,
			order: [],
			accounts: {}
		};
		this.slots.clear();
		this.flush();
	}
	/** 暂停/恢复。 */
	async setPaused(id, paused) {
		return this.patch(id, { paused });
	}
	/** 置顶/取消置顶。 */
	async setPinned(id, pinned) {
		return this.patch(id, { pinned });
	}
	/** 改备注名。 */
	async setLabel(id, label) {
		const trimmed = label.trim();
		if (trimmed === "") return this.patch(id, { label: void 0 });
		return this.patch(id, { label: trimmed });
	}
	async patch(id, changes) {
		await this.ensureLoaded();
		const account = this.doc.accounts[id];
		if (account === void 0) return false;
		const next = {
			...account,
			...changes
		};
		if (changes.label === void 0) delete next.label;
		this.doc.accounts[id] = next;
		this.slots.get(id)?.replace(next);
		this.flush();
		return true;
	}
	/**
	* 解析一个账号，拿到可直接用的会话（必要时静默重登）。
	*
	* @returns 会话；账号不存在、暂停或确实需要人工登录时 undefined。
	*/
	async resolve(id) {
		await this.ensureLoaded();
		const account = this.doc.accounts[id];
		if (account === void 0) return void 0;
		if (account.paused === true) return void 0;
		const slot = this.slot(id, account);
		const session = await slot.session();
		if (session === void 0 || session === "") return void 0;
		return {
			id,
			account: slot.current(),
			session
		};
	}
	/** 强制重登一个账号（卡片「重新登录」按钮）。 */
	async forceRelogin(id) {
		await this.ensureLoaded();
		const account = this.doc.accounts[id];
		if (account === void 0) return false;
		return this.slot(id, account).forceRelogin();
	}
	/** 上游明确否定了这个会话：有密码就等着自动重登，没密码就标成待登录。 */
	async markRejected(id, reason) {
		await this.ensureLoaded();
		const account = this.doc.accounts[id];
		if (account === void 0) return;
		this.slot(id, account).noteRejected(reason);
	}
	/** 从磁盘重读（另一个进程/用户手工改了文档时）。 */
	async reloadFromDisk() {
		const before = JSON.stringify(this.doc);
		this.document = void 0;
		this.loading = void 0;
		this.slots.clear();
		await this.ensureLoaded();
		return JSON.stringify(this.doc) !== before;
	}
	/**
	* 保活：把「会话快到期」的账号提前续掉。
	*
	* 会话是 14 天，用户可能一周不开 DSH —— 不保活的话下次开就要等一次登录。
	* 这一轮只续有密码的账号；没密码的账号到期只能人工再来，所以这里把它的剩余天数
	* 报出去让卡片提醒。
	*/
	async keepAlive() {
		await this.ensureLoaded();
		let refreshed = 0;
		const needsLogin = [];
		for (const id of [...this.doc.order]) {
			const account = this.doc.accounts[id];
			if (account === void 0) continue;
			if (account.paused === true) continue;
			const slot = this.slot(id, account);
			const before = slot.current().session;
			const session = await slot.session();
			if (session === void 0) {
				needsLogin.push(id);
				continue;
			}
			if (session !== before) refreshed += 1;
		}
		return {
			checked: this.doc.order.length,
			refreshed,
			needsLogin
		};
	}
};
var LoomyAccountPool = class {
	accounts = /* @__PURE__ */ new Map();
	/** 用户手动暂停的账号：运行时状态留着（卡片还看得见槽位），但不参与轮转。 */
	paused = /* @__PURE__ */ new Set();
	/** 用户置顶的账号：选号时排在最前面。 */
	preferred = /* @__PURE__ */ new Set();
	maxConcurrent;
	now;
	available;
	/** 等槽位的唤醒器。 */
	waiters = /* @__PURE__ */ new Set();
	strategy;
	/** 轮转游标（`round_robin`）。 */
	cursor = 0;
	constructor(ids, options = {}) {
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
		this.now = options.now ?? (() => Date.now());
		this.available = options.available ?? (() => void 0);
		this.strategy = options.strategy ?? "balance";
		this.sync(ids);
	}
	/** 切策略（配置变更时）。 */
	setStrategy(strategy) {
		this.strategy = strategy;
	}
	currentStrategy() {
		return this.strategy;
	}
	/** 让池与账号文档对齐：新增的进来，删掉的出去。已有账号的运行时状态保留。 */
	sync(ids) {
		const wanted = new Set(ids);
		const before = this.accounts.size;
		for (const id of [...this.accounts.keys()]) if (!wanted.has(id)) this.accounts.delete(id);
		for (const id of ids) {
			if (this.accounts.has(id)) continue;
			this.accounts.set(id, {
				id,
				activeConcurrent: 0,
				maxConcurrent: this.maxConcurrent,
				coolUntil: 0,
				disabled: false,
				lastUsed: 0,
				errorCount: 0
			});
		}
		if (this.accounts.size !== before) this.notifyWaiters();
	}
	list() {
		return [...this.accounts.values()];
	}
	get(id) {
		return this.accounts.get(id);
	}
	/** 账号本身可用（没被禁用、不在冷却中）。 */
	healthy(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return false;
		return !account.disabled && this.now() >= account.coolUntil;
	}
	/** 现在就能接活的账号，按策略排好序。 */
	available_(exclude) {
		const now = this.now();
		const candidates = this.list().filter((account) => !account.disabled && !this.paused.has(account.id) && now >= account.coolUntil && !exclude.has(account.id) && account.activeConcurrent < account.maxConcurrent);
		const pinned = (account) => this.preferred.has(account.id) ? 1 : 0;
		if (this.strategy === "round_robin") {
			const size = candidates.length;
			if (size === 0) return candidates;
			const start = this.cursor % size;
			return [...candidates.slice(start), ...candidates.slice(0, start)].sort((a, b) => pinned(b) - pinned(a));
		}
		if (this.strategy === "lru") return candidates.sort((a, b) => pinned(b) - pinned(a) || a.lastUsed - b.lastUsed);
		return candidates.sort((a, b) => {
			const pin = pinned(b) - pinned(a);
			if (pin !== 0) return pin;
			const left = this.available(a.id);
			const right = this.available(b.id);
			if (left === void 0 && right === void 0) return a.lastUsed - b.lastUsed;
			if (left === void 0) return 1;
			if (right === void 0) return -1;
			if (right !== left) return right - left;
			return a.lastUsed - b.lastUsed;
		});
	}
	/** 设置暂停集合（账号 id）。 */
	setPaused(ids) {
		this.paused.clear();
		for (const id of ids) this.paused.add(id);
		this.notifyWaiters();
	}
	pausedIds() {
		return [...this.paused];
	}
	/** 设置置顶集合（账号 id）。置顶只在「同时可用」时改变先后，不绕过冷却/上限。 */
	setPreferred(ids) {
		this.preferred.clear();
		for (const id of ids) this.preferred.add(id);
	}
	preferredIds() {
		return [...this.preferred];
	}
	/** 选一个账号（跳过 `exclude` 里的）。 */
	pick(exclude = /* @__PURE__ */ new Set()) {
		const chosen = this.available_(exclude)[0];
		if (chosen === void 0) return void 0;
		if (this.strategy === "round_robin") this.cursor += 1;
		return chosen.id;
	}
	/** 占一个本地槽位。占用失败（已满/不存在）返回 false。 */
	acquire(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return false;
		if (account.activeConcurrent >= account.maxConcurrent) return false;
		account.activeConcurrent += 1;
		account.lastUsed = this.now();
		return true;
	}
	/** 释放槽位；重复释放不会把计数压到负数。 */
	release(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		if (account.activeConcurrent > 0) account.activeConcurrent -= 1;
		this.notifyWaiters();
	}
	notifyWaiters() {
		for (const waiter of [...this.waiters]) try {
			waiter();
		} catch {}
	}
	/** 现在是否有一个真正能接活的空槽位。 */
	hasFreeSlot() {
		const now = this.now();
		return this.list().some((account) => !account.disabled && !this.paused.has(account.id) && now >= account.coolUntil && account.activeConcurrent < account.maxConcurrent);
	}
	/** 有没有「健康、但本地槽位被占满」的号 —— 只有这种值得等一会儿。 */
	hasBusyWaitable() {
		const now = this.now();
		return this.list().some((account) => !account.disabled && !this.paused.has(account.id) && now >= account.coolUntil && account.activeConcurrent >= account.maxConcurrent);
	}
	/** 等一个本地槽位空出来，最多 `maxWaitMs`。 */
	waitForFreeSlot(maxWaitMs, signal) {
		if (this.hasFreeSlot()) return Promise.resolve(true);
		if (!this.hasBusyWaitable() || maxWaitMs <= 0) return Promise.resolve(false);
		if (signal?.aborted === true) return Promise.resolve(false);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				this.waiters.delete(check);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const check = () => {
				if (this.hasFreeSlot()) finish(true);
			};
			const onAbort = () => finish(false);
			const timer = setTimeout(() => finish(false), maxWaitMs);
			timer.unref?.();
			this.waiters.add(check);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	/** 凭据失效等硬错误：直接停用，等用户重新登录。 */
	disable(id, reason) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.disabled = true;
		account.lastError = reason;
	}
	/** 用户重新登录后调用：把账号从禁用/冷却里捞出来。 */
	revive(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.disabled = false;
		account.coolUntil = 0;
		account.errorCount = 0;
		account.lastError = void 0;
		this.notifyWaiters();
	}
	/** 上游 5xx / 软限流：短时冷却。 */
	cooldown(id, ms, reason) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.coolUntil = this.now() + ms;
		account.lastError = reason;
	}
	/** 累计错误；达到阈值就冷却。 */
	noteError(id, threshold, cooldownMs, reason) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.errorCount += 1;
		account.lastError = reason;
		if (threshold > 0 && account.errorCount >= threshold) account.coolUntil = this.now() + cooldownMs;
	}
	/** 一次成功：清掉错误计数与冷却。 */
	noteSuccess(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.errorCount = 0;
		account.coolUntil = 0;
		account.lastError = void 0;
	}
	/** 有没有任何账号可用（含被暂停之外的）。 */
	hasUsable() {
		const now = this.now();
		return this.list().some((account) => !account.disabled && now >= account.coolUntil);
	}
};
// src/catalog.ts
/**
* Loomy 模型目录。
*
* **目录只放上游给的东西。** 唯一来源是 `GET /models`（`docs/PROTOCOL.md` 第 5 节）：
* 启动时、每小时、以及卡片上「刷新模型」各拉一次，取所有成功账号的并集。上游没返回的
* 模型就是没有，未登录时目录为空 —— 不拿一份历史名单冒充「可用模型」。
*
* 为什么必须守住这条：上游对**不认识的模型 id 会静默回退**到 `deepseek-v4-flash-0731`
* 并回 200。所以「目录里有什么」是唯一可信的可用模型集合，猜一个 id 只会让用户以为
* 自己在用别的模型。
*
* @module dsh-loomy/catalog
*/
/** 可变目录，由 shim 的 `/v1/models` 与适配器共享。 */
var LoomyCatalog = class {
	/** 空目录起步：没发现过就是没有模型。 */
	models = [];
	current() {
		return this.models;
	}
	set(models) {
		this.models = [...models];
	}
	/** 按 id 找一条（大小写不敏感，接受 `imodel/` 前缀）。 */
	find(id) {
		const wire = upstreamModelId(id).toLowerCase();
		if (wire === "") return void 0;
		return this.models.find((model) => model.id.toLowerCase() === wire);
	}
};
/** 把目录收窄到用户勾选的子集（空/缺省 = 全给）。 */
function filterEnabledModels(models, enabled) {
	if (enabled === void 0 || enabled.length === 0) return models;
	const allow = new Set(enabled.map((id) => upstreamModelId(id).toLowerCase()).filter((id) => id !== ""));
	const kept = models.filter((model) => allow.has(model.id.toLowerCase()));
	return kept.length === 0 ? models : kept;
}
/**
* 合并多路来源（多账号）的模型清单。
*
* 规则：
*  - 按 id 去重（大小写不敏感）；
*  - 参数更全的一条优先（有真窗口 > 兜底窗口，支持图片 > 不支持）；
*  - 输出按 id 排序，保证刷新前后顺序稳定。
*/
function mergeModelLists(sets) {
	const merged = /* @__PURE__ */ new Map();
	for (const set of sets) for (const model of set) {
		const id = model.id.trim();
		if (id === "") continue;
		const key = id.toLowerCase();
		const current = merged.get(key);
		merged.set(key, current === void 0 ? {
			...model,
			id
		} : richerModel(current, model));
	}
	return [...merged.values()].sort((a, b) => a.id.toLowerCase() < b.id.toLowerCase() ? -1 : 1);
}
function richerModel(current, next) {
	const keep = richerThan(next, current) ? next : current;
	const drop = keep === next ? current : next;
	const merged = {
		...keep,
		contextWindow: keep.contextWindowKnown === true || drop.contextWindowKnown !== true ? keep.contextWindow : drop.contextWindow,
		maxTokens: keep.maxTokens > 0 ? keep.maxTokens : drop.maxTokens,
		supportsImages: keep.supportsImages || drop.supportsImages,
		...drop.reasoning === true || keep.reasoning === true ? { reasoning: true } : {},
		...drop.toolCall === true || keep.toolCall === true ? { toolCall: true } : {},
		...drop.streaming === true || keep.streaming === true ? { streaming: true } : {},
		...keep.thinking === void 0 && drop.thinking === void 0 ? {} : { thinking: keep.thinking ?? drop.thinking }
	};
	if (keep.contextWindowKnown !== true && drop.contextWindowKnown !== true) delete merged.contextWindowKnown;
	return merged;
}
function richerThan(a, b) {
	const aKnown = a.contextWindowKnown === true;
	if (aKnown !== (b.contextWindowKnown === true)) return aKnown;
	if (a.contextWindow > 0 !== b.contextWindow > 0) return a.contextWindow > 0;
	if (a.maxTokens > 0 !== b.maxTokens > 0) return a.maxTokens > 0;
	return a.supportsImages && !b.supportsImages;
}
// src/upstream.ts
/**
* 模型网关这一层的「怎么说话」：请求头、地址、错误归类、用量抽取。
*
* 上游是 OpenAI 兼容的，所以请求体基本可以原样转发 —— 真正的坑全在头上
* （`docs/PROTOCOL.md` 第 2 节）：
*
* - `Authorization: Bearer <session>` **和** `token: <session>` 都发（客户端两种都认）；
* - `traceparent` 必须在：**没有它上游会挂到超时**，而且报错是「超时」不是「缺头」；
* - `loomy-version` 只检查存在；
* - 流式与非流式是**同一个路径**，靠 body 里的 `stream` 区分（与 DevEco 相反）。
*
* @module dsh-loomy/upstream
*/
/** 一次请求要带的会话头。 */
function buildModelHeaders(session, extra = {}) {
	return {
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
		Authorization: `Bearer ${session}`,
		token: session,
		traceparent: newTraceparent(),
		"loomy-version": extra.version ?? "0.9.38",
		"X-Loomy-Request-Purpose": extra.purpose ?? "chat.message"
	};
}
/** W3C traceparent：`00-<32 hex>-<16 hex>-01`。 */
function newTraceparent() {
	return `00-${randomUUID().replace(/-/g, "")}-${randomUUID().replace(/-/g, "").slice(0, 16)}-01`;
}
/** 聊天地址（流式/非流式同一个路径）。 */
function chatUrl() {
	return `${modelBase()}${MODEL_PATHS.chat}`;
}
/** 模型目录地址。 */
function modelsUrl() {
	return `${modelBase()}${MODEL_PATHS.models}`;
}
/** 点数记录地址（`data.{balance, dailyBalance, availableBalance}`）。 */
function pointsUrl(pageSize = 1) {
	return `${modelBase()}${MODEL_PATHS.points}?record_type=all&page_no=1&page_size=${String(pageSize)}`;
}
/** 从响应体里抠出可读的错误文本。 */
async function readErrorText(response) {
	try {
		const text = await response.text();
		if (text === "") return `HTTP ${response.status}`;
		try {
			const parsed = JSON.parse(text);
			if (isObject$3(parsed)) {
				const error = parsed.error;
				if (typeof error === "string") return error;
				if (isObject$3(error) && typeof error.message === "string") return error.message;
				if (typeof parsed.message === "string") return parsed.message;
				if (typeof parsed.msg === "string") return parsed.msg;
				if (typeof parsed.desc === "string" && parsed.desc !== "") return parsed.desc;
			}
		} catch {}
		return text.length > 600 ? `${text.slice(0, 600)}…` : text;
	} catch {
		return `HTTP ${response.status}`;
	}
}
/**
* 归类一次上游失败。
*
* 上游的语义（`docs/PROTOCOL.md` 第 7 节 + 实测）：
*
* | 信号 | 含义 | 处理 |
* |---|---|---|
* | `401` / `403` | 会话失效 | 有密码就自动重登，没密码标待登录 |
* | `402` / 点数不足 | 额度用完 | 冷却该号，换号重试 |
* | `429` | 限流 | 冷却该号，换号重试 |
* | `5xx` / `408` | 上游抖动 | 换号重试 |
* | 400 + 长度关键词 | 上下文溢出 | 直接报清楚，不重试 |
*/
function classifyUpstreamError(status, message) {
	const text = message.toLowerCase();
	if (status === 401 || status === 403) return {
		kind: "auth",
		status,
		message,
		retryable: true,
		needsLogin: true
	};
	if (status === 402 || text.includes("insufficient") || text.includes("points") || text.includes("余额")) return {
		kind: "quota",
		status,
		message,
		retryable: true,
		needsLogin: false
	};
	if (status === 429 || text.includes("rate limit") || text.includes("too many")) return {
		kind: "rate-limit",
		status,
		message,
		retryable: true,
		needsLogin: false
	};
	if (status === 413 || status === 400 && looksLikeLengthError(text)) return {
		kind: "context",
		status,
		message,
		retryable: false,
		needsLogin: false
	};
	if (status === 400 && (text.includes("model") || text.includes("param") || text.includes("unsupported"))) return {
		kind: "model",
		status,
		message,
		retryable: false,
		needsLogin: false
	};
	if (status >= 500 || status === 408) return {
		kind: "server",
		status,
		message,
		retryable: true,
		needsLogin: false
	};
	return {
		kind: "server",
		status,
		message,
		retryable: false,
		needsLogin: false
	};
}
function looksLikeLengthError(text) {
	return text.includes("too long") || text.includes("prompt length") || text.includes("maximum input length") || text.includes("context length") || text.includes("context_length_exceeded") || text.includes("too many tokens") || text.includes("overlimit");
}
function isObject$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numberOrUndefined$1(value) {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
	}
}
/** 从一次响应体里取用量。 */
function usageFromJson(body) {
	if (!isObject$3(body)) return {};
	const usage = body.usage;
	if (!isObject$3(usage)) return {};
	const input = numberOrUndefined$1(usage.prompt_tokens ?? usage.input_tokens);
	const output = numberOrUndefined$1(usage.completion_tokens ?? usage.output_tokens);
	const reasoning = numberOrUndefined$1((isObject$3(usage.completion_tokens_details) ? usage.completion_tokens_details : void 0)?.reasoning_tokens ?? usage.reasoning_tokens);
	const points = numberOrUndefined$1(usage.points_consumed);
	return {
		...input === void 0 ? {} : { inputTokens: input },
		...output === void 0 ? {} : { outputTokens: output },
		...reasoning === void 0 ? {} : { reasoningTokens: reasoning },
		...points === void 0 ? {} : { pointsConsumed: points }
	};
}
/**
* 从一行 SSE `data:` 里取用量。
*
* 流式响应通常在最后一个块带 `usage`（`points_consumed` 也在里面），也可能压根不带 ——
* 拿不到就不记，绝不猜。
*/
function usageFromSseLine(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return void 0;
	const payload = trimmed.slice(5).trim();
	if (payload === "" || payload === "[DONE]") return void 0;
	if (!payload.includes("usage")) return void 0;
	try {
		const usage = usageFromJson(JSON.parse(payload));
		return Object.keys(usage).length === 0 ? void 0 : usage;
	} catch {
		return;
	}
}
/**
* 流式响应里第一帧的错误。
*
* 上游有时以 **200 + SSE** 的形式报错：第一帧是 `data: {"error":{...}}`。原样透传给
* pi-ai，它会把这段当正文渲染出来，用户看到一堆 JSON 而不是错误提示。
*/
function firstFrameError(text) {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		try {
			const parsed = JSON.parse(payload);
			if (!isObject$3(parsed)) continue;
			const error = parsed.error;
			if (isObject$3(error) && typeof error.message === "string") return error.message;
			if (typeof error === "string" && error !== "") return error;
		} catch {}
	}
}
// src/discovery.ts
/**
* 动态模型发现：`GET /models`。
*
* 上游按**账号**返回目录（额度、套餐可能不同），所以多账号要逐号拉一次再取并集 ——
* 一个号失败不影响其它号。结果是「真实可用模型」的唯一来源。
*
* 响应形状（`docs/PROTOCOL.md` 第 5 节）：
*
* ```jsonc
* { "object": "list",
*   "data": [ { "id": "deepseek-v4-flash-0731", "object": "model",
*               "name": "DeepSeek V4 Flash 0731 (x3.0)",
*               "context_length": 1048576,
*               "max_output_tokens": 32768,
*               "capabilities": { "reasoning": true, "vision": false,
*                                 "function_calling": true, "streaming": true },
*               "reasoning_efforts": ["low", "high"] } ] }
* ```
*
* 也见过套一层 `{code, data:[…]}` 的形态，所以解析器对两种都容忍；但**不猜**：
* 一个条目没有 `id` 就当它不存在。
*
* @module dsh-loomy/discovery
*/
function isObject$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringList(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	else if (isObject$2(item)) {
		const level = item.level ?? item.name ?? item.id;
		if (typeof level === "string" && level.trim() !== "") out.push(level.trim());
	}
	return out;
}
/** `context_length` / `max_output_tokens` 可能是数字也可能是字符串。 */
function parsePositiveInt(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
}
/** 从展示名里抠出点数倍率：`GLM 5.3 Flash (x0.8)` → `0.8`。 */
function parseMultiplier(name) {
	const match = /\(\s*x\s*([0-9]+(?:\.[0-9]+)?)\s*\)/i.exec(name);
	if (match === null) return void 0;
	const value = Number.parseFloat(match[1] ?? "");
	return Number.isFinite(value) ? value : void 0;
}
/** 档位：`["low","high"]`、`[{level:"low"}]`、`{level:[…],default:"high"}` 都接受。 */
function parseReasoningEfforts(raw) {
	if (raw === void 0 || raw === null) return void 0;
	if (Array.isArray(raw)) {
		const levels = stringList(raw);
		return levels.length === 0 ? void 0 : { levels };
	}
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed === "") return void 0;
		try {
			return parseReasoningEfforts(JSON.parse(trimmed));
		} catch {
			return;
		}
	}
	if (!isObject$2(raw)) return void 0;
	const levels = stringList(raw.level);
	if (levels.length === 0) return void 0;
	const fallback = typeof raw.default === "string" && levels.includes(raw.default) ? raw.default : void 0;
	return fallback === void 0 ? { levels } : {
		levels,
		default: fallback
	};
}
/** 视觉能力：`capabilities.vision`，或 `modality`/`input_modalities` 里出现 image。 */
function supportsImages(entry, capabilities) {
	if (capabilities?.vision === true) return true;
	for (const field of [entry.modality, entry.input_modalities]) {
		const items = Array.isArray(field) ? field : typeof field === "string" ? [field] : [];
		for (const item of items) if (typeof item === "string" && item.toLowerCase().includes("image")) return true;
	}
	return false;
}
/** 一条 `data[]` → 目录项；没有 id 就是 undefined。 */
function toModelInfo(raw) {
	if (!isObject$2(raw)) return void 0;
	const entry = raw;
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (id === "") return void 0;
	const capabilities = isObject$2(entry.capabilities) ? entry.capabilities : void 0;
	const contextWindow = parsePositiveInt(entry.context_length);
	const maxTokens = parsePositiveInt(entry.max_output_tokens ?? entry.max_tokens);
	const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id;
	const multiplier = parseMultiplier(name);
	const thinking = parseReasoningEfforts(entry.reasoning_efforts ?? entry.reasoning_effort);
	return {
		id,
		name,
		contextWindow: contextWindow ?? 0,
		...contextWindow === void 0 ? {} : { contextWindowKnown: true },
		maxTokens: maxTokens ?? 0,
		supportsImages: supportsImages(entry, capabilities),
		...capabilities?.reasoning === true ? { reasoning: true } : {},
		...capabilities?.function_calling === true ? { toolCall: true } : {},
		...capabilities?.streaming === true ? { streaming: true } : {},
		...thinking === void 0 ? {} : { thinking },
		...multiplier === void 0 ? {} : { multiplier }
	};
}
/** 找到载荷里的模型数组（`data[]` 或 `data.data[]` 或根数组）。 */
function modelArray(raw) {
	if (Array.isArray(raw)) return raw;
	if (!isObject$2(raw)) return [];
	if (Array.isArray(raw.data)) return raw.data;
	if (isObject$2(raw.data) && Array.isArray(raw.data.data)) return raw.data.data;
	if (Array.isArray(raw.models)) return raw.models;
	return [];
}
/** 解析整个 `/models` 响应。 */
function parseModelsPayload(raw) {
	const models = [];
	for (const entry of modelArray(raw)) {
		const info = toModelInfo(entry);
		if (info !== void 0) models.push(info);
	}
	return { models: mergeModelLists([models]) };
}
/** 拉一个账号的模型目录。 */
async function fetchModels(session, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15e3);
	timer.unref?.();
	options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
	try {
		const response = await fetchImpl(modelsUrl(), {
			method: "GET",
			headers: buildModelHeaders(session),
			signal: controller.signal
		});
		if (!response.ok) throw new Error(`GET /models returned HTTP ${response.status}`);
		const parsed = parseModelsPayload(await response.json());
		if (parsed.models.length === 0) throw new Error("GET /models listed no usable model");
		return parsed;
	} finally {
		clearTimeout(timer);
	}
}
/** 逐号发现并合并。 */
async function discoverModels(store, signal) {
	const ids = await store.dispatchIds();
	const perAccount = [];
	const sets = [];
	for (const id of ids) try {
		const resolved = await store.resolve(id);
		if (resolved === void 0) {
			perAccount.push({
				id,
				models: 0,
				errors: ["no usable session"]
			});
			continue;
		}
		const fetched = await fetchModels(resolved.session, signal === void 0 ? {} : { signal });
		sets.push([...fetched.models]);
		perAccount.push({
			id,
			models: fetched.models.length,
			errors: []
		});
	} catch (error) {
		perAccount.push({
			id,
			models: 0,
			errors: [error instanceof Error ? error.message : String(error)]
		});
	}
	return {
		models: mergeModelLists(sets),
		anySucceeded: sets.some((set) => set.length > 0),
		accounts: perAccount
	};
}
/** 拉一次目录并写进 `catalog`；失败时保留旧目录（上游抖动不该清空模型选择器）。 */
async function refreshCatalog(store, catalog, signal) {
	const outcome = await discoverModels(store, signal);
	if (outcome.anySucceeded && outcome.models.length > 0) catalog.set(outcome.models);
	return outcome;
}
// src/usage.ts
/**
* 本机用量台账。
*
* 两个口径都要记，因为它们的含义不同：
*
* - **tokens**（`usage.prompt_tokens` / `completion_tokens`）—— 上下文消耗；
* - **points**（`usage.points_consumed`）—— 上游实际扣的点数，按模型倍率算的。
*
* 只记**本机经这个插件发出去的**请求：账号级的余额由 `points.ts` 从上游读，两个数字
* 不能混为一谈（其它设备/客户端也在花同一个号的点数）。
*
* `today` 按**本地自然日**归零。上游的 `dailyBalance` 什么时候重置没有公开，所以这里
* 不去编一个「额度窗口」—— 本机用量就是本机用量。
*
* @module dsh-loomy/usage
*/
const EMPTY_TOTALS = {
	requests: 0,
	failures: 0,
	inputTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0,
	points: 0
};
/** 本地**自然日**键 `YYYY-MM-DD`。 */
function localDayKey(at = Date.now()) {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
function addTotals(target, event) {
	return {
		requests: target.requests + 1,
		failures: target.failures + (event.ok ? 0 : 1),
		inputTokens: target.inputTokens + (event.inputTokens ?? 0),
		outputTokens: target.outputTokens + (event.outputTokens ?? 0),
		reasoningTokens: target.reasoningTokens + (event.reasoningTokens ?? 0),
		points: target.points + (event.points ?? 0)
	};
}
var LoomyUsageTracker = class {
	path;
	document = {
		version: 1,
		scope: "local",
		day: localDayKey(),
		totals: { ...EMPTY_TOTALS },
		today: { ...EMPTY_TOTALS },
		byAccount: {},
		byModel: {},
		recent: [],
		updatedAt: Date.now()
	};
	loaded = false;
	flushTimer;
	constructor(options) {
		this.path = options.path;
	}
	/** 读盘。失败/文件缺失都不影响插件启动。 */
	async load() {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.path)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed !== "object" || parsed === null) return;
			this.document = {
				version: 1,
				scope: "local",
				day: typeof parsed.day === "string" ? parsed.day : localDayKey(),
				totals: normalizeTotals(parsed.totals),
				today: normalizeTotals(parsed.today),
				byAccount: normalizeBuckets(parsed.byAccount),
				byModel: normalizeBuckets(parsed.byModel),
				recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-100) : [],
				updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now()
			};
			this.rollDay();
		} catch {}
	}
	/** 记一次请求。 */
	record(event) {
		const at = event.at ?? Date.now();
		this.rollDay();
		const full = {
			at,
			account: event.account,
			model: event.model,
			ok: event.ok,
			ms: event.ms,
			...event.inputTokens === void 0 ? {} : { inputTokens: event.inputTokens },
			...event.outputTokens === void 0 ? {} : { outputTokens: event.outputTokens },
			...event.reasoningTokens === void 0 ? {} : { reasoningTokens: event.reasoningTokens },
			...event.points === void 0 ? {} : { points: event.points }
		};
		this.document.totals = addTotals(this.document.totals, full);
		this.document.today = addTotals(this.document.today, full);
		this.document.byAccount[full.account] = addTotals(this.document.byAccount[full.account] ?? { ...EMPTY_TOTALS }, full);
		this.document.byModel[full.model] = addTotals(this.document.byModel[full.model] ?? { ...EMPTY_TOTALS }, full);
		this.document.recent = [...this.document.recent.slice(-99), full];
		this.document.updatedAt = at;
		this.scheduleFlush();
	}
	/** 立刻落盘（插件停用时调）。 */
	async flush() {
		if (this.flushTimer !== void 0) {
			clearTimeout(this.flushTimer);
			this.flushTimer = void 0;
		}
		const dir = dirname(this.path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const temp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(this.document, void 0, 2)}\n`, "utf8");
		renameSync(temp, this.path);
	}
	/** 当前快照。 */
	snapshot() {
		this.rollDay();
		return {
			scope: "local",
			day: this.document.day,
			totals: { ...this.document.totals },
			today: { ...this.document.today },
			byAccount: { ...this.document.byAccount },
			byModel: { ...this.document.byModel },
			recent: [...this.document.recent].reverse()
		};
	}
	scheduleFlush() {
		if (this.flushTimer !== void 0) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = void 0;
			this.flush().catch(() => {});
		}, 2e3);
		this.flushTimer.unref?.();
	}
	/** 跨天把 `today` 归零（`totals` 保留）。 */
	rollDay() {
		const day = localDayKey();
		if (day === this.document.day) return;
		this.document.day = day;
		this.document.today = { ...EMPTY_TOTALS };
	}
};
function normalizeTotals(value) {
	if (typeof value !== "object" || value === null) return { ...EMPTY_TOTALS };
	const raw = value;
	return {
		requests: numberOr0(raw.requests),
		failures: numberOr0(raw.failures),
		inputTokens: numberOr0(raw.inputTokens),
		outputTokens: numberOr0(raw.outputTokens),
		reasoningTokens: numberOr0(raw.reasoningTokens),
		points: numberOr0(raw.points)
	};
}
function normalizeBuckets(value) {
	if (typeof value !== "object" || value === null) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) out[key] = normalizeTotals(entry);
	return out;
}
function numberOr0(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
// src/points.ts
/**
* 点数（额度）：上游**真的**有账本，所以这里不编数字。
*
* `GET /points/records` 返回（`docs/PROTOCOL.md` 第 5 节）：
*
* ```jsonc
* { "code": "000000",
*   "data": { "balance": 5000,        // 永久点数
*             "dailyBalance": 4877,   // 每日赠送（先扣，按天重置）
*             "availableBalance": 9877,
*             "list": [ … ] } }
* ```
*
* 与 DevEco 那个插件不同：那边上游没有余额接口，只能算本机用量；这里可以诚实地显示
* 「这个号现在还剩多少点」，并且用 `availableBalance` 做**额度感知选号**
* （策略 `balance`，见 `account-pool.ts`）。
*
* 语义边界（必须写进卡片，别让用户误读）：
*
* - `dailyBalance` 是**每日赠送**，官方没有公开重置时刻，所以只展示数值，不编倒计时；
* - 余额是**账号级**的（多设备共用），不是本机用量；
* - 一个请求实际扣多少点由模型倍率决定（`x0.1` … `x12.0`），上游在响应的
*   `usage.points_consumed` 里给准确值，本机账本记的是那个数。
*
* @module dsh-loomy/points
*/
function isObject$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numberOrUndefined(value) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return Math.floor(parsed);
	}
}
/** 解析 `/points/records` 响应：`data.*` 或顶层同名字段都接受。 */
function parsePoints(raw) {
	if (!isObject$1(raw)) return {};
	const data = isObject$1(raw.data) ? raw.data : raw;
	const balance = numberOrUndefined(data.balance);
	const dailyBalance = numberOrUndefined(data.dailyBalance);
	const available = numberOrUndefined(data.availableBalance) ?? (balance === void 0 && dailyBalance === void 0 ? void 0 : (balance ?? 0) + (dailyBalance ?? 0));
	return {
		...balance === void 0 ? {} : { balance },
		...dailyBalance === void 0 ? {} : { dailyBalance },
		...available === void 0 ? {} : { available }
	};
}
/** 拉一个账号的点数。 */
async function fetchPoints(session, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15e3);
	timer.unref?.();
	options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
	try {
		const response = await fetchImpl(pointsUrl(), {
			method: "GET",
			headers: buildModelHeaders(session),
			signal: controller.signal
		});
		if (!response.ok) throw new Error(`GET /points/records returned HTTP ${response.status}`);
		return parsePoints(await response.json());
	} finally {
		clearTimeout(timer);
	}
}
/** 点数缓存 + 「额度用尽」标记。 */
var LoomyPointsTracker = class {
	accounts = /* @__PURE__ */ new Map();
	/** 记一次成功的查询。 */
	noteOk(id, snapshot, at = Date.now()) {
		const previous = this.accounts.get(id);
		this.accounts.set(id, {
			...previous,
			snapshot: {
				...previous?.snapshot,
				...snapshot
			},
			checkedAt: at,
			error: void 0,
			exhaustedAt: void 0,
			exhaustedReason: void 0
		});
	}
	/** 记一次查询失败（保留上一次数值）。 */
	noteError(id, message) {
		const previous = this.accounts.get(id) ?? {};
		this.accounts.set(id, {
			...previous,
			error: message
		});
	}
	/** 记一次「上游说点数不足」。 */
	noteExhausted(id, reason, at = Date.now()) {
		const previous = this.accounts.get(id) ?? {};
		this.accounts.set(id, {
			...previous,
			exhaustedAt: at,
			exhaustedReason: reason
		});
	}
	/** 上游接受了一次请求：说明这个号现在有额度。 */
	noteServed(id) {
		const previous = this.accounts.get(id);
		if (previous === void 0) return;
		if (previous.exhaustedAt === void 0) return;
		this.accounts.set(id, {
			...previous,
			exhaustedAt: void 0,
			exhaustedReason: void 0
		});
	}
	state(id) {
		return this.accounts.get(id);
	}
	/** 这个号现在还能接活吗（没被标额度用尽）。 */
	usable(id) {
		return this.accounts.get(id)?.exhaustedAt === void 0;
	}
	/**
	* 额度感知选号用的权值。
	*
	* 没查到过余额的账号给 `undefined`（让池用「最久未用」兜底）；查到 0 的账号也参与
	* 轮转（余额为 0 不等于请求一定失败：每日赠送可能还没刷新进来）。
	*/
	available(id) {
		return this.accounts.get(id)?.snapshot?.available;
	}
	/** 快照（给状态文档/诊断）。 */
	snapshot() {
		return Object.fromEntries([...this.accounts].map(([id, value]) => [id, { ...value }]));
	}
	/** 清掉已删除账号的缓存。 */
	prune(ids) {
		const keep = new Set(ids);
		for (const id of [...this.accounts.keys()]) if (!keep.has(id)) this.accounts.delete(id);
	}
	clear() {
		this.accounts.clear();
	}
};
/** 上游的「没点数了」长什么样（402 之外，也可能是 403 + 文案）。 */
function looksLikeQuotaExhausted(status, message) {
	if (status === 402) return true;
	const text = message.toLowerCase();
	return text.includes("insufficient") || text.includes("no enough") || text.includes("not enough") || text.includes("quota") || text.includes("余额不足") || text.includes("点数不足") || text.includes("积分不足");
}
// src/queue.ts
/**
* 上游生成的并发闸门。
*
* Loomy 的限流不透明（既没有公开的 RPM，也没有「排队位置」），但我们知道两件事：
* 打得太密会被 429，而 429 之后重试又要重新排队。所以本地先排：默认 1 个在飞、最多 3 个
* 等待，再多直接 429 —— 排队上限存在的意义是**别让用户以为它还在跑**。
*
* 排队入场的请求先冷却一小会儿（默认 500ms），避免刚释放就撞上上游的计数窗口。
*
* @module dsh-loomy/queue
*/
/** 队列满时给调用方的错误（pi-ai 会把它显示成一次失败）。 */
const QUEUE_FULL_MESSAGE = "upstream generation queue is full, please retry shortly";
var LoomyQueueGate = class {
	active = 0;
	waiters = [];
	maxConcurrent;
	maxQueue;
	cooldownMs;
	disposed = false;
	constructor(options = {}) {
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
		this.maxQueue = Math.max(0, options.maxQueue ?? 3);
		this.cooldownMs = Math.max(0, options.cooldownMs ?? 500);
	}
	/**
	* 申请一个生成位。
	*
	* @returns `true` = 拿到了，用完必须 `release()`；`false` = 队列已满（调用方回 429）。
	*/
	async acquire(signal) {
		if (this.disposed) return false;
		if (signal?.aborted === true) return false;
		if (this.active < this.maxConcurrent && this.waiters.length === 0) {
			this.active += 1;
			return true;
		}
		if (this.waiters.length >= this.maxQueue) return false;
		return await new Promise((resolve) => {
			const waiter = {
				resolve,
				granted: false
			};
			const onAbort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index === -1) return;
				this.waiters.splice(index, 1);
				if (waiter.timer !== void 0) clearTimeout(waiter.timer);
				resolve(false);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const originalResolve = waiter.resolve;
			waiter.resolve = (granted) => {
				signal?.removeEventListener("abort", onAbort);
				originalResolve(granted);
			};
			this.waiters.push(waiter);
			this.pump();
		});
	}
	/** 释放一个生成位，并让队首入场。 */
	release() {
		if (this.active > 0) this.active -= 1;
		this.pump();
	}
	/** 队列里还有几个在等。 */
	queued() {
		return this.waiters.length;
	}
	snapshot() {
		return {
			active: this.active,
			queued: this.waiters.length,
			maxConcurrent: this.maxConcurrent,
			maxQueue: this.maxQueue
		};
	}
	/** 撤掉所有等待者（插件停用）。 */
	dispose() {
		this.disposed = true;
		for (const waiter of this.waiters.splice(0)) {
			if (waiter.timer !== void 0) clearTimeout(waiter.timer);
			waiter.resolve(false);
		}
	}
	/** 有空位就把队首放进来（排队过的请求先冷却一小会儿）。 */
	pump() {
		if (this.disposed) return;
		while (this.active < this.maxConcurrent) {
			const waiter = this.waiters.shift();
			if (waiter === void 0) return;
			const grant = () => {
				if (waiter.granted) return;
				waiter.granted = true;
				this.active += 1;
				waiter.resolve(true);
			};
			if (this.cooldownMs === 0) {
				grant();
				continue;
			}
			waiter.timer = setTimeout(grant, this.cooldownMs);
			waiter.timer.unref?.();
			return;
		}
	}
};
// src/loopback.ts
/**
* Shared loopback gates for the plugin's local HTTP surfaces: the loopback
* shim and the same-origin web-status route. Both are only ever meant to be
* addressed through the machine's loopback interface.
*
* The 127.0.0.1 bind alone is not a trust boundary (any local process or a
* DNS-rebinding page can reach 127.0.0.1), so both surfaces also check the
* Host and Origin headers.
*
* @module dsh-loomy/loopback
*/
/**
* Loopback hostnames a local plugin surface may be addressed by.
*
* `0.0.0.0` and `::` are deliberately absent: they are wildcard *bind*
* addresses, not loopback identities, and accepting them in a Host header
* would let a request that never went through the loopback interface pass.
*/
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
// src/shim.ts
/**
* 本机回环 shim：把 pi-ai 的 OpenAI 请求翻译成 Loomy 模型网关的请求。
*
* 为什么要有这一层，而不是让适配器直连上游：
*
* - 上游要求一批 pi-ai 不会发的头（`token` / `traceparent` / `loomy-version`），
*   其中 `traceparent` 缺了上游会**挂到超时**（`upstream.ts`）；
* - 会话是账号级的，多账号轮转、失败换号、额度冷却都发生在这一层；
* - 并发闸门、点数记账、用量台账也只能在这里做（响应是流式的，适配器只看得到文本）。
*
* 适配器那边只需把 `baseUrl` 指向这里、apiKey 用这里发的随机 secret，其余照旧。
*
* @module dsh-loomy/shim
*/
/** 等一个本地槽位最多等多久。 */
const SLOT_WAIT_MS = 5e3;
/** 请求体上限。 */
const MAX_BODY_BYTES = 33554432;
/** 探首帧时最多缓冲多少字节。 */
const PEEK_LIMIT = 8192;
/** 额度用尽后的冷却（点数不会几秒就回来）。 */
const QUOTA_COOLDOWN_MS = 6e5;
function json$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** OpenAI 风格的错误体（pi-ai 认识这个形状）。 */
function openAiError(res, status, message, type = "upstream_error") {
	json$1(res, status, { error: {
		message,
		type,
		code: status
	} });
}
function readBody$1(req, limit = MAX_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", (error) => reject(error));
	});
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* 模型校验：上游对不认识的 id **静默回退**到默认模型，所以未知 id 必须在这里拦下来。
*
* 目录为空（还没登录/还没发现）时放行 —— 这时上游会自己报错，比本地拦一道更诚实。
*/
function resolveRequestedModel(catalog, requested) {
	const wire = upstreamModelId(requested);
	if (wire === "") return catalog.current().length === 0 ? { wire } : {
		wire,
		unknown: "the request carried no model id"
	};
	const info = catalog.find(wire);
	if (info !== void 0) return {
		wire: info.id,
		info
	};
	if (catalog.current().length === 0) return { wire };
	return {
		wire,
		unknown: `unknown model "${wire}" (upstream would silently answer with its default model)`
	};
}
function createLoomyShim(options) {
	const { store, pool, catalog, usage, points, logger } = options;
	const secret = randomUUID().replace(/-/g, "");
	const queue = new LoomyQueueGate({
		maxConcurrent: envNumber("LOOMY_MAX_CONCURRENCY", 1),
		maxQueue: envNumber("LOOMY_MAX_QUEUE", 3),
		cooldownMs: envNumber("LOOMY_QUEUE_COOLDOWN_MS", 500)
	});
	const idleTimeoutMs = envNumber("UPSTREAM_IDLE_TIMEOUT_MS", DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS);
	let server;
	let port = 0;
	const stats = { port: 0 };
	const authorized = (req) => {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		return (header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim()) === secret;
	};
	const handleModels = (req, res) => {
		if (!hostIsLoopback(req.headers.host)) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		json$1(res, 200, {
			object: "list",
			data: filterEnabledModels(catalog.current(), options.enabledModels?.()).map((model) => ({
				id: exposedModelId(model.id),
				object: "model",
				owned_by: "loomy",
				name: model.name,
				...model.contextWindowKnown === true ? { context_length: model.contextWindow } : {},
				...model.maxTokens > 0 ? { max_output_tokens: model.maxTokens } : {},
				capabilities: {
					reasoning: model.reasoning === true,
					vision: model.supportsImages,
					function_calling: model.toolCall === true,
					streaming: model.streaming !== false
				}
			}))
		});
	};
	/** 把上游响应写回 pi-ai，并记账。 */
	const pipeUpstream = async (res, params) => {
		const { response, stream, accountId, wireModel, started } = params;
		let usageRecord = {};
		try {
			if (!stream) {
				const text = await response.text();
				try {
					usageRecord = usageFromJson(JSON.parse(text));
				} catch {}
				usage.record(buildUsageEvent(accountId, wireModel, started, usageRecord, true));
				res.writeHead(200, {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(text)
				});
				res.end(text);
				return;
			}
			const body = response.body;
			if (body === null) {
				openAiError(res, 502, "dsh-loomy: upstream returned an empty stream");
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive"
			});
			const reader = body.getReader();
			const decoder = new TextDecoder();
			let carry = "";
			let peeked = "";
			let decided = false;
			/** 中途断流 / 上游报错时置位：账本要如实记成一次失败。 */
			let failed = false;
			let idleTimer;
			const armIdle = () => {
				if (idleTimer !== void 0) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					logger?.warn("dsh-loomy: upstream stream idle timeout; aborting this turn");
					reader.cancel().catch(() => {});
				}, idleTimeoutMs);
				idleTimer.unref?.();
			};
			try {
				armIdle();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value === void 0) continue;
					armIdle();
					let text = decoder.decode(value, { stream: true });
					if (!decided) {
						peeked += text;
						if (peeked.length < PEEK_LIMIT && !peeked.includes("\n")) continue;
						decided = true;
						const early = firstFrameError(peeked);
						if (early !== void 0) {
							await reader.cancel().catch(() => {});
							const classified = classifyUpstreamError(400, early);
							stats.lastError = `early: ${early}`;
							openAiError(res, 502, classified.message, classified.kind);
							usage.record(buildUsageEvent(accountId, wireModel, started, {}, false));
							return;
						}
						text = peeked;
						peeked = "";
					}
					carry += text;
					const newline = carry.lastIndexOf("\n");
					if (newline !== -1) {
						const complete = carry.slice(0, newline);
						carry = carry.slice(newline + 1);
						for (const line of complete.split("\n")) {
							const usageLine = usageFromSseLine(line);
							if (usageLine !== void 0) usageRecord = usageLine;
						}
					}
					res.write(value);
				}
				if (carry !== "") {
					const usageLine = usageFromSseLine(carry);
					if (usageLine !== void 0) usageRecord = usageLine;
				}
			} catch (error) {
				failed = true;
				logger?.debug(`dsh-loomy: upstream stream ended early (${error instanceof Error ? error.message : String(error)})`);
			} finally {
				if (idleTimer !== void 0) clearTimeout(idleTimer);
				res.end();
				usage.record(buildUsageEvent(accountId, wireModel, started, usageRecord, !failed));
				if (usageRecord.pointsConsumed !== void 0) points.noteServed(accountId);
			}
		} finally {}
	};
	const handleChat = async (req, res) => {
		if (!hostIsLoopback(req.headers.host)) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!authorized(req)) {
			openAiError(res, 401, "dsh-loomy: missing or wrong shim token", "auth_error");
			return;
		}
		let body;
		try {
			const parsed = JSON.parse(await readBody$1(req));
			if (!isObject(parsed)) throw new Error("not an object");
			body = parsed;
		} catch {
			openAiError(res, 400, "dsh-loomy: request body is not a JSON object", "invalid_request_error");
			return;
		}
		const stream = body.stream === true;
		const requestedModel = typeof body.model === "string" ? body.model : "";
		const resolvedModel = resolveRequestedModel(catalog, requestedModel);
		if (resolvedModel.unknown !== void 0) {
			openAiError(res, 400, `dsh-loomy: ${resolvedModel.unknown}`, "invalid_request_error");
			return;
		}
		const wireModel = resolvedModel.wire;
		if (!await queue.acquire()) {
			openAiError(res, 429, QUEUE_FULL_MESSAGE, "rate_limit_error");
			return;
		}
		const controller = new AbortController();
		const onClose = () => controller.abort();
		res.on("close", onClose);
		const exclude = /* @__PURE__ */ new Set();
		let lastError;
		try {
			for (let index = 0; index < 3; index += 1) {
				if (!await pool.waitForFreeSlot(SLOT_WAIT_MS, controller.signal)) {
					lastError ??= {
						kind: "rate-limit",
						status: 429,
						message: "every Loomy account is busy right now; please retry shortly",
						retryable: false,
						needsLogin: false
					};
					break;
				}
				const accountId = pool.pick(exclude);
				if (accountId === void 0) {
					lastError ??= {
						kind: "auth",
						status: 401,
						message: "no usable Loomy account; sign in from the Loomy plugin card",
						retryable: false,
						needsLogin: true
					};
					break;
				}
				if (!pool.acquire(accountId)) {
					exclude.add(accountId);
					continue;
				}
				try {
					const resolved = await store.resolve(accountId);
					if (resolved === void 0) {
						pool.disable(accountId, "session needs sign-in");
						lastError = {
							kind: "auth",
							status: 401,
							message: "a Loomy account needs to sign in again",
							retryable: true,
							needsLogin: true
						};
						exclude.add(accountId);
						continue;
					}
					const started = Date.now();
					let response;
					try {
						response = await fetch(chatUrl(), {
							method: "POST",
							headers: buildModelHeaders(resolved.session),
							body: JSON.stringify({
								...body,
								model: wireModel,
								stream
							}),
							signal: controller.signal
						});
					} catch (error) {
						usage.record(buildUsageEvent(accountId, wireModel, started, {}, false));
						pool.noteError(accountId, 3, 3e4, "network error");
						lastError = {
							kind: "network",
							status: 0,
							message: error instanceof Error ? error.message : String(error),
							retryable: true,
							needsLogin: false
						};
						exclude.add(accountId);
						continue;
					}
					if (response.ok) {
						pool.noteSuccess(accountId);
						points.noteServed(accountId);
						stats.lastAccount = accountId;
						stats.lastModel = wireModel;
						stats.lastStatus = response.status;
						stats.lastLatencyMs = Date.now() - started;
						stats.lastError = void 0;
						await pipeUpstream(res, {
							response,
							stream,
							accountId,
							wireModel,
							started
						});
						return;
					}
					const message = await readErrorText(response);
					const classified = classifyUpstreamError(response.status, message);
					usage.record(buildUsageEvent(accountId, wireModel, started, {}, false));
					stats.lastStatus = response.status;
					stats.lastError = `${classified.kind}: ${message}`;
					if (looksLikeQuotaExhausted(response.status, message)) {
						points.noteExhausted(accountId, message);
						pool.cooldown(accountId, QUOTA_COOLDOWN_MS, `out of points: ${message}`);
					} else if (classified.needsLogin) {
						await store.markRejected(accountId, `upstream ${response.status}: ${message}`);
						if (classified.status === 401) pool.disable(accountId, `upstream ${response.status}`);
					} else if (classified.kind === "rate-limit" || classified.kind === "server") pool.noteError(accountId, 3, 2e4, `${classified.kind}: ${message}`);
					lastError = classified;
					exclude.add(accountId);
					if (!classified.retryable) break;
				} finally {
					pool.release(accountId);
				}
			}
			const error = lastError ?? {
				kind: "server",
				status: 500,
				message: "dsh-loomy: no account could serve this request",
				retryable: false,
				needsLogin: false
			};
			if (!res.headersSent) openAiError(res, error.status === 0 ? 502 : error.status, error.message, error.kind);
			else res.end();
		} finally {
			res.off("close", onClose);
			queue.release();
		}
	};
	const handler = (req, res) => {
		const path = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`).pathname.replace(/\/$/, "");
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
			handleModels(req, res);
			return;
		}
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
			handleChat(req, res).catch((error) => {
				logger?.warn("dsh-loomy: shim request failed", error);
				if (!res.headersSent) openAiError(res, 500, error instanceof Error ? error.message : String(error));
				else res.end();
			});
			return;
		}
		if (req.method === "GET" && path === "/health") {
			json$1(res, 200, {
				ok: true,
				accounts: pool.list().length,
				queue: queue.snapshot(),
				stats
			});
			return;
		}
		json$1(res, 404, { error: "not found" });
	};
	return {
		baseUrl: () => `http://127.0.0.1:${String(port)}`,
		token: () => secret,
		ready: new Promise((resolve, reject) => {
			const instance = createServer(handler);
			instance.once("error", reject);
			instance.listen(0, "127.0.0.1", () => {
				server = instance;
				port = instance.address()?.port ?? 0;
				stats.port = port;
				resolve();
			});
		}),
		close: async () => {
			queue.dispose();
			const instance = server;
			server = void 0;
			if (instance === void 0) return;
			await new Promise((resolve) => {
				instance.close(() => resolve());
				setTimeout(resolve, 500).unref?.();
			});
		},
		stats: () => ({ ...stats })
	};
}
/** 一条用量事件（把 `ChatUsage` 摊平）。 */
function buildUsageEvent(account, model, started, record, ok) {
	return {
		account,
		model,
		ok,
		ms: Date.now() - started,
		...record.inputTokens === void 0 ? {} : { inputTokens: record.inputTokens },
		...record.outputTokens === void 0 ? {} : { outputTokens: record.outputTokens },
		...record.reasoningTokens === void 0 ? {} : { reasoningTokens: record.reasoningTokens },
		...record.pointsConsumed === void 0 ? {} : { points: record.pointsConsumed }
	};
}
// node_modules/.pnpm/@earendil-works+pi-ai@1.5.2_bfcf7ff884c6418f8e350fe360d1f5d5/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js
const openAICompletionsApi = () => lazyApi(() => import("./openai-completions-BKw9Uk1C.mjs"));
// src/adapter.ts
/**
* `loomy` 这个 pi-ai provider。
*
* 一个适配器，把 DSH 的 LLM seam 接到本机回环 shim 上（`shim.ts` 做真正的上游转发）。
* 这里只描述模型、把 `baseUrl` 指向 shim、并把 apiKey 换成 shim 的进程内 secret。
*
* 与 DevEco 的适配器几乎一样，差别只在模型元数据：Loomy 的目录里有倍率、工具调用与
* 逐模型的思考档位，这些都要映射成 pi-ai 认的形状，否则模型选择器会给出上游不接受的
* 档位（比如对只会 low/high 的模型显示 Off/Minimal）。
*
* @module dsh-loomy/adapter
*/
/** 这个 bundle 拥有的 provider 路由。与 `cordis.patch.yml` 保持一致。 */
const LOOMY_PROVIDER = "loomy";
/**
* 等上游开流时的空闲上限。
*
* 120s：Loomy 的思考模型（`spark-x` / `deepseek-v4-flash-0731`）会先吐 `reasoning_content`，
* 首 token 之后仍可能长段静默。给 120s 既能容忍冷启动，又能让 DSH 自己的重试策略
* 更快接管（它把 TIMEOUT 当可重试）。
*/
const LOOMY_STREAM_IDLE_TIMEOUT_MS = 12e4;
/** 订阅额度按点数计，没有可算的单价，一律报 0。 */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/** 惰性的 pi-ai 凭证面：loomy 路由只靠 shim 的 secret 鉴权。 */
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-loomy: the loomy route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** pi-ai 认的档位，按由弱到强排列。 */
const REASONING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* 上游声明的思考档位 → pi-ai 的推理元数据。
*
* 上游没声明的档位一律钉成 `null`：pi-ai 把「没写」当成「支持」，漏掉的话界面会给一个
* 只会 low/high 的模型显示 Off/Minimal/Low/Medium。`off` 同样钉死 —— 上游默认就在思考，
* 声称支持 Off 只会发出一个不带档位的请求，然后照样思考。
*/
function thinkingFields(strengths) {
	const offered = new Set((strengths ?? []).map((level) => level.trim().toLowerCase()));
	if (!REASONING_LEVELS.some((level) => level !== "off" && offered.has(level))) return { reasoning: false };
	const map = {};
	for (const level of REASONING_LEVELS) map[level] = offered.has(level) ? level : null;
	return {
		reasoning: true,
		thinkingLevelMap: map
	};
}
/** 一条目录项 → pi-ai 模型描述（指向 shim）。 */
function toPiModel(info, baseUrl) {
	const thinking = thinkingFields(info.thinking?.levels);
	const reasoning = info.reasoning === true || thinking.reasoning;
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: LOOMY_PROVIDER,
		baseUrl,
		input: info.supportsImages ? ["text", "image"] : ["text"],
		reasoning,
		...thinking.thinkingLevelMap === void 0 ? {} : { thinkingLevelMap: thinking.thinkingLevelMap },
		cost: NO_COST,
		contextWindow: info.contextWindow > 0 ? info.contextWindow : 32768,
		maxTokens: info.maxTokens > 0 ? info.maxTokens : 8192
	};
}
function createLoomyAdapter(options) {
	const { shim, catalog, enabledModels, resolveAttachments } = options;
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl));
	};
	const provider = {
		...createProvider({
			id: LOOMY_PROVIDER,
			name: "Loomy",
			auth: { apiKey: {
				name: "Loomy shim key",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "Loomy"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: LOOMY_PROVIDER,
		displayName: "Loomy",
		streamIdleTimeoutMs: LOOMY_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-loomy retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[LOOMY_PROVIDER, profile]]);
	return {
		adapter: new LoomyPiAiAdapter(catalog, enabledModels, {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[LOOMY_PROVIDER, profile]]);
		}
	};
}
/** 把**对外**模型面收窄到用户勾选的子集（分发不受影响）。 */
var LoomyPiAiAdapter = class extends PiAiAdapter {
	catalog;
	enabledModels;
	constructor(catalog, enabledModels, options) {
		super(options);
		this.catalog = catalog;
		this.enabledModels = enabledModels;
	}
	async listModels(provider) {
		const models = await super.listModels(provider);
		const allowed = filterEnabledModels(this.catalog.current(), this.enabledModels?.());
		const catalogIds = new Set(this.catalog.current().map((entry) => entry.id));
		const allowedIds = new Set(allowed.map((entry) => entry.id));
		return models.filter((model) => !catalogIds.has(model.id) || allowedIds.has(model.id));
	}
	async resolveModel(provider, model, signal) {
		return super.resolveModel(provider, model, signal);
	}
};
// src/settings-compat.ts
const compatModule = settingsModule;
function plainSettingsSchema(schema) {
	const clone = structuredClone(schema.toJSON());
	for (const node of Object.values(clone.refs ?? {})) if (node !== null && typeof node === "object" && node.meta !== void 0) delete node.meta.volatile;
	return z(clone);
}
function entryNamespaceOf(ctx) {
	const compat = ctx;
	const entry = compat.fiber?.entry;
	const candidates = [
		entry?.options?.id,
		entry?.id,
		compat.loader?.locate?.(compat.fiber)
	];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate !== "") return candidate;
}
function resolveSettingsNamespaceCompat(ctx, provider, fallback) {
	if (compatModule.installSettingsSection !== void 0) return fallback;
	if (provider === void 0 || provider === null) return fallback;
	const candidate = provider;
	if (candidate.installSection !== void 0) return fallback;
	if (candidate.configure !== void 0) return entryNamespaceOf(ctx) ?? fallback;
	return fallback;
}
function installSettingsSectionCompat(ctx, ns, schema, entry, hooks) {
	const legacyInstaller = compatModule.installSettingsSection;
	if (legacyInstaller !== void 0) {
		legacyInstaller(ctx, ns, plainSettingsSchema(schema), entry, hooks);
		return;
	}
	ctx.inject(["settings"], (sctx) => {
		const provider = sctx.get("settings");
		if (provider === void 0) return;
		if (provider.installSection !== void 0) {
			provider.installSection(ctx, ns, plainSettingsSchema(schema), entry, hooks);
			return;
		}
		if (provider.configure === void 0) throw new TypeError("dsh-settings exposes neither installSection nor configure");
		sctx.effect(() => {
			const dispose = provider.configure?.({ auto: false }, ctx.fiber);
			return typeof dispose === "function" ? dispose : () => {};
		});
		const namespace = entryNamespaceOf(ctx);
		if (namespace !== void 0) {
			const refresh = () => {
				const descriptor = provider.describe?.().find((entry) => String(entry.ns) === namespace);
				if (descriptor?.value !== void 0) hooks.setSource?.(() => descriptor.value);
				hooks.onChange();
			};
			const settingsEvents = sctx;
			sctx.effect(() => settingsEvents.on("settings/document-updated", (updated) => {
				if (String(updated) === namespace) refresh();
			}));
		}
	});
}
// src/web-status.ts
const LOOMY_STATUS_PATH = "/api/loomy/status";
const LOOMY_MODELS_PATH = "/api/loomy/models";
const LOOMY_SELECTION_PATH = "/api/loomy/enabled-models";
const LOOMY_ACCOUNTS_PATH = "/api/loomy/accounts";
const LOOMY_LOGIN_PATH = "/api/loomy/login";
const LOOMY_SMS_PATH = "/api/loomy/sms";
const LOOMY_SESSION_PATH = "/api/loomy/session";
const LOOMY_POINTS_PATH = "/api/loomy/points";
const LOOMY_REFRESH_MODELS_PATH = "/api/loomy/refresh-models";
const LOOMY_DOCK_PATH = "/api/loomy/dock";
const LOOMY_DOCTOR_PATH = "/api/loomy/doctor";
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** 只信任来回路环的请求。 */
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/** 写操作必须是 JSON。 */
function isJsonRequest(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.toLowerCase().includes("application/json");
}
function readBody(req, limit = 1 << 20) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(/* @__PURE__ */ new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
async function readJson(req) {
	const raw = await readBody(req);
	if (raw.trim() === "") return {};
	const parsed = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be a JSON object");
	return parsed;
}
function safeMessage(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
function toWebModel(model) {
	return {
		id: model.id,
		name: model.name,
		...model.contextWindowKnown === true && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
		...model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {},
		...model.supportsImages ? { supportsImages: true } : {},
		...model.reasoning ? { reasoning: true } : {},
		...model.toolCall ? { toolCall: true } : {},
		...model.thinking === void 0 ? {} : { levels: model.thinking.levels },
		...model.multiplier === void 0 ? {} : { multiplier: model.multiplier }
	};
}
/** 组装状态文档（不含任何凭证）。 */
async function buildStatus(deps) {
	const summaries = await deps.store.list();
	const slots = new Map(deps.pool().map((entry) => [entry.id, entry]));
	const points = deps.points();
	const accounts = summaries.map((summary) => {
		const slot = slots.get(summary.id);
		const pointState = points[summary.id];
		return {
			...summary,
			...slot === void 0 ? {} : { slot: {
				activeConcurrent: slot.activeConcurrent,
				maxConcurrent: slot.maxConcurrent,
				coolUntil: slot.coolUntil,
				disabled: slot.disabled,
				...slot.lastError === void 0 ? {} : { lastError: slot.lastError }
			} },
			...pointState === void 0 ? {} : { points: pointState }
		};
	});
	return {
		version: deps.version,
		provider: LOOMY_PROVIDER,
		node: process.version,
		strategy: deps.strategy(),
		signedIn: accounts.length > 0,
		accounts,
		models: deps.models().map(toWebModel),
		usage: deps.usage(),
		pointsNote: deps.pointsNote,
		dock: deps.dock(),
		writable: true,
		shim: deps.shimStats(),
		providerRegistered: deps.providerRegistered()
	};
}
/** 勾选面板的数据。 */
function selectionOf(deps) {
	const models = deps.models();
	const enabled = deps.enabledModels();
	const allow = enabled === void 0 || enabled.length === 0 ? void 0 : new Set(enabled.map((id) => id.toLowerCase()));
	const choices = models.map((model) => ({
		...toWebModel(model),
		enabled: allow === void 0 || allow.has(model.id.toLowerCase())
	}));
	return {
		choices,
		restricted: choices.some((choice) => !choice.enabled),
		writable: true
	};
}
function statusHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		json(res, 200, { status: await buildStatus(deps) });
	};
}
function modelsHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		json(res, 200, { models: deps.models().map(toWebModel) });
	};
}
function selectionHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method === "GET") {
			json(res, 200, { selection: selectionOf(deps) });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = await readJson(req);
			if (!Array.isArray(body.enabledModels) || body.enabledModels.some((id) => typeof id !== "string")) {
				json(res, 400, { error: "enabledModels must be an array of model ids" });
				return;
			}
			if (!await deps.setEnabledModels(body.enabledModels)) {
				json(res, 403, { error: "selection-not-writable" });
				return;
			}
			json(res, 200, {
				ok: true,
				selection: selectionOf(deps)
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
/** 新增账号：手机号 + 密码（服务端登录）。 */
function loginHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = await readJson(req);
			const loginid = typeof body.loginid === "string" ? body.loginid.trim() : "";
			const password = typeof body.password === "string" ? body.password : "";
			const label = typeof body.label === "string" ? body.label : void 0;
			if (loginid === "" || password === "") {
				json(res, 400, { error: "loginid and password are required" });
				return;
			}
			const created = await deps.store.signInWithPassword({
				loginid,
				password,
				...label === void 0 ? {} : { label }
			});
			await deps.afterAccountChange(created.id);
			deps.reviveAccount(created.id);
			json(res, 200, {
				ok: true,
				id: created.id,
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
/** 短信验证码：`POST {loginid}` 发码 / `POST {loginid, code, msgid}` 换会话。 */
function smsHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = await readJson(req);
			const loginid = typeof body.loginid === "string" ? body.loginid.trim() : "";
			if (loginid === "") {
				json(res, 400, { error: "loginid is required" });
				return;
			}
			const code = typeof body.code === "string" ? body.code.trim() : "";
			const msgid = typeof body.msgid === "string" ? body.msgid.trim() : "";
			if (code === "" || msgid === "") {
				json(res, 200, {
					ok: true,
					msgid: await deps.store.accountService.sendSmsCode(loginid)
				});
				return;
			}
			const created = await deps.store.signInWithSms({
				loginid,
				code,
				msgid,
				...typeof body.label === "string" ? { label: body.label } : {}
			});
			await deps.afterAccountChange(created.id);
			deps.reviveAccount(created.id);
			json(res, 200, {
				ok: true,
				id: created.id,
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
/** 粘贴一个已有会话（没有密码，只用于「先让它跑起来」）。 */
function sessionHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = await readJson(req);
			const session = typeof body.session === "string" ? body.session.trim() : "";
			if (session === "") {
				json(res, 400, { error: "session is required" });
				return;
			}
			const probe = await deps.store.accountService.baseInfo(session).then(() => void 0, (error) => safeMessage(error));
			if (probe !== void 0) {
				json(res, 400, { error: `the session was rejected by the account service: ${probe}` });
				return;
			}
			const id = await deps.store.addSession({
				session,
				...typeof body.label === "string" && body.label.trim() !== "" ? { label: body.label.trim() } : {},
				...typeof body.loginid === "string" && body.loginid.trim() !== "" ? { loginid: body.loginid.trim() } : {}
			});
			await deps.afterAccountChange(id);
			deps.reviveAccount(id);
			json(res, 200, {
				ok: true,
				id,
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
/** 账号操作：暂停/置顶/改备注/补密码/重新登录。 */
function accountsHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method === "DELETE") {
			const id = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("id");
			if (id === null || id === "") {
				json(res, 400, { error: "missing id" });
				return;
			}
			await deps.store.remove(id);
			await deps.afterAccountChange();
			json(res, 200, {
				ok: true,
				status: await buildStatus(deps)
			});
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = await readJson(req);
			const id = typeof body.id === "string" ? body.id : "";
			if (id === "") {
				json(res, 400, { error: "missing id" });
				return;
			}
			let touched = false;
			if (typeof body.paused === "boolean") touched = await deps.store.setPaused(id, body.paused) || touched;
			if (typeof body.pinned === "boolean") touched = await deps.store.setPinned(id, body.pinned) || touched;
			if (typeof body.label === "string") touched = await deps.store.setLabel(id, body.label) || touched;
			if (typeof body.password === "string") touched = await deps.store.setPassword(id, body.password) || touched;
			if (body.relogin === true) touched = await deps.store.forceRelogin(id) || touched;
			if (!touched) {
				json(res, 404, { error: "unknown account or nothing to change" });
				return;
			}
			await deps.afterAccountChange(id);
			deps.reviveAccount(id);
			json(res, 200, {
				ok: true,
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
/** 点数：GET 读缓存；POST 重新查一遍（会打上游，但很轻）。 */
function pointsHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method === "GET") {
			json(res, 200, { points: deps.points() });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			json(res, 200, {
				outcome: await deps.refreshPoints(),
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 500, { error: safeMessage(error) });
		}
	};
}
function refreshModelsHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		try {
			json(res, 200, {
				...await deps.refreshModels(),
				selection: selectionOf(deps),
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 500, { error: safeMessage(error) });
		}
	};
}
function dockHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method === "GET") {
			json(res, 200, {
				dock: deps.dock(),
				writable: true
			});
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = await readJson(req);
			const patch = {};
			for (const key of [
				"dock",
				"sidebar",
				"settingsEntry"
			]) if (typeof body[key] === "boolean") patch[key] = body[key];
			if (!await deps.setDock(patch)) {
				json(res, 403, { error: "dock-not-writable" });
				return;
			}
			json(res, 200, {
				ok: true,
				dock: deps.dock(),
				writable: true
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
function doctorHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		const status = await buildStatus(deps);
		const shim = deps.shimStats();
		const usable = status.accounts.filter((account) => account.usable && !account.paused);
		const withBalance = status.accounts.filter((account) => (account.points?.snapshot?.available ?? 0) > 0);
		const checks = [
			{
				id: "version",
				ok: true,
				detail: `${status.version} on ${status.node}`
			},
			{
				id: "accounts",
				ok: status.accounts.length > 0,
				detail: status.accounts.length === 0 ? "no account signed in" : `${status.accounts.length} account(s)`
			},
			{
				id: "usable-accounts",
				ok: usable.length > 0,
				detail: usable.length === 0 ? "every account needs sign-in or is paused" : `${usable.length} usable`
			},
			{
				id: "catalog",
				ok: status.models.length > 0,
				detail: status.models.length === 0 ? "model catalog is empty" : `${status.models.length} model(s)`
			},
			{
				id: "shim",
				ok: shim.port > 0,
				detail: shim.port > 0 ? `loopback shim on port ${shim.port}` : "shim is not listening"
			},
			{
				id: "provider",
				ok: status.providerRegistered,
				detail: status.providerRegistered ? "provider loomy is registered" : "provider loomy is NOT registered"
			},
			{
				id: "points",
				ok: status.accounts.length === 0 || withBalance.length > 0,
				detail: status.accounts.length === 0 ? "no account to look up" : withBalance.length === 0 ? "no account reports a positive balance yet (try refreshing points)" : `${withBalance.length} account(s) with points`
			}
		];
		json(res, 200, { report: {
			ok: checks.every((check) => check.ok),
			version: status.version,
			node: status.node,
			checks,
			hints: status.accounts.length === 0 ? ["add a Loomy account with its phone number and password (or paste a session)"] : []
		} });
	};
}
/** 挂载全部路由。 */
function registerLoomyStatusRoutes(ctx, deps) {
	ctx.effect(() => {
		const disposers = [
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_STATUS_PATH,
				handler: statusHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_MODELS_PATH,
				handler: modelsHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_SELECTION_PATH,
				handler: selectionHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_ACCOUNTS_PATH,
				handler: accountsHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_LOGIN_PATH,
				handler: loginHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_SMS_PATH,
				handler: smsHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_SESSION_PATH,
				handler: sessionHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_POINTS_PATH,
				handler: pointsHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_REFRESH_MODELS_PATH,
				handler: refreshModelsHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_DOCK_PATH,
				handler: dockHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: LOOMY_DOCTOR_PATH,
				handler: doctorHandler(deps)
			})
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-loomy: web routes");
}
// src/version.ts
/** 构建时由 tsdown 注入的包版本；直接跑源码（测试/调试）时退化成 dev 标记。 */
const LOOMY_VERSION = "0.1.0";
// src/index.ts
/**
* Loomy（讯飞桌面助手）的模型接入 DeepSeek Harness。
*
* 插件注册一个 `loomy` provider，请求经本机回环 shim 转发到 Loomy 的模型网关。
* 登录是**服务端**的：手机号 + 密码（RSA 加密）换一个 14 天会话，会话就是模型的
* Bearer；快到期时插件自己用存着的密码再登一次（上游没有 refresh token）。
*
* 多账号：`.loomy-accounts.json` 存账号，池按点数余额/轮转/最久未用选号 —— 上游每个号
* 的额度是分开的，多一个号就多一份可用点数。模型目录来自上游 `GET /models`，启动时与
* 每小时各拉一次，失败保留上一次的结果。
*
* 点数：上游有 `/points/records`，所以这里显示的是**真余额**（不是本机估算），
* 卡片和体检都据此判断「这个号还有没有额度」。
*
* @module dsh-loomy
*/
/** 稳定的 Cordis 插件名（与 `cordis.patch.yml` 的 id 对齐）。 */
const name = "llm-loomy";
/** provider 注册前必须先有 `llm` 服务。 */
const inject = ["llm"];
/** 拥有配置卡片的 settings 命名空间。 */
const LOOMY_SETTINGS_NS = "loomy";
function unwrapVolatileValue(value) {
	if (typeof value === "object" && value !== null && typeof value.get === "function") return value.get();
	return value;
}
function unwrapConfig(value) {
	if (typeof value !== "object" || value === null) return {};
	const out = {};
	for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field);
	return out;
}
const Config = z.object({
	enabledModels: z.array(z.string()).description("Model ids offered in the model pickers (empty means every model)").volatile(),
	showDock: z.boolean().default(true).description("Show the Loomy line (provider, model, today points) under the chat input box").volatile(),
	showSidebarPanel: z.boolean().default(false).description("Show a Loomy icon in the DSH sidebar icon column").volatile(),
	showSettingsEntry: z.boolean().default(true).description("Show a Loomy entry in the left navigation of DSH Settings").volatile(),
	maxConcurrent: z.natural().default(1).description("Concurrent upstream generations").volatile(),
	maxQueue: z.natural().default(3).description("Local queue depth before requests are rejected with 429").volatile(),
	strategy: z.union([
		"balance",
		"round_robin",
		"lru"
	]).default("balance").description("Account selection strategy: balance (most points first), round_robin, or lru").volatile(),
	autoRenew: z.boolean().default(true).description("Sign in again with the stored password before the 14-day session expires").volatile()
});
/** 点数说明（卡片直接展示，别让用户以为这是本机估算）。 */
const POINTS_NOTE = "These are the account-level points the Loomy gateway reports: available = permanent balance + the daily grant. The daily grant resets on the upstream side, so no countdown is shown. \"Today\" below is only what THIS machine spent through this plugin.";
function settingsCompatNamespace(ctx) {
	return resolveSettingsNamespaceCompat(ctx, ctx.get("settings"), LOOMY_SETTINGS_NS);
}
function apply(ctx, rawConfig) {
	const config = unwrapConfig(rawConfig);
	/**
	* 续期/登录失败日志。
	*
	* 宿主对插件的 info/debug 没有出口，warn 会变成系统通知 —— 一次网络抖动就弹一次窗口
	* 不行。所以失败原因写插件自己的文件，1MB 截断重来。
	*/
	const appendRefreshLog = (message) => {
		try {
			const path = loomyRefreshLogPath();
			try {
				if (statSync(path).size > 1e6) writeFileSync(path, "");
			} catch {}
			appendFileSync(path, `${(/* @__PURE__ */ new Date()).toISOString()} ${message}\n`, { mode: 384 });
		} catch {}
	};
	const points = new LoomyPointsTracker();
	const store = new LoomyAccountStore(loomyAccountsPath(), {
		log: appendRefreshLog,
		identityMode: process.env.LOOMY_IDENTITY_MODE === "client" ? "client" : "per_account"
	});
	const pool = new LoomyAccountPool([], {
		maxConcurrent: config.maxConcurrent ?? 1,
		strategy: config.strategy ?? "balance",
		available: (id) => points.available(id)
	});
	const catalog = new LoomyCatalog();
	const usage = new LoomyUsageTracker({ path: loomyUsagePath() });
	let current = () => config;
	const dock = () => ({
		dock: current().showDock !== false,
		sidebar: current().showSidebarPanel === true,
		settingsEntry: current().showSettingsEntry !== false
	});
	const setDock = async (patch) => {
		const settings = ctx.get("settings");
		if (settings === void 0) return false;
		await settings.update(settingsCompatNamespace(ctx), {
			...patch.dock === void 0 ? {} : { showDock: patch.dock },
			...patch.sidebar === void 0 ? {} : { showSidebarPanel: patch.sidebar },
			...patch.settingsEntry === void 0 ? {} : { showSettingsEntry: patch.settingsEntry }
		});
		return true;
	};
	const setEnabledModels = async (ids) => {
		const settings = ctx.get("settings");
		if (settings === void 0) return false;
		await settings.update(settingsCompatNamespace(ctx), { enabledModels: [...ids] });
		return true;
	};
	/** 把池与账号文档对齐（新增/删除账号后调）。 */
	const syncPool = async () => {
		const ids = await store.ids();
		pool.sync(ids);
		const summaries = await store.list();
		pool.setPaused(summaries.filter((entry) => entry.paused).map((entry) => entry.id));
		pool.setPreferred(summaries.filter((entry) => entry.pinned).map((entry) => entry.id));
		pool.setStrategy(current().strategy ?? "balance");
		points.prune(ids);
	};
	/**
	* 重新查一遍所有账号的点数。
	*
	* 这是**真查询**（`GET /points/records`），不像 DevEco 那边只能拿目录探活 —— 上游确实
	* 有账本。失败时保留上一次的数值，绝不清成 0。
	*/
	const refreshPoints = async () => {
		await syncPool();
		const ids = await store.dispatchIds();
		const accounts = [];
		for (const id of ids) try {
			const resolved = await store.resolve(id);
			if (resolved === void 0) {
				accounts.push({
					id,
					ok: false,
					message: "account needs sign-in"
				});
				continue;
			}
			const snapshot = await fetchPoints(resolved.session);
			points.noteOk(id, snapshot);
			accounts.push({
				id,
				ok: true,
				...snapshot.available === void 0 ? {} : { available: snapshot.available }
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (looksLikeQuotaExhausted(0, message)) points.noteExhausted(id, message);
			else points.noteError(id, message);
			accounts.push({
				id,
				ok: false,
				message
			});
		}
		const probed = accounts.length;
		const ok = accounts.some((entry) => entry.ok);
		const known = accounts.filter((entry) => entry.available !== void 0);
		const total = known.reduce((sum, entry) => sum + (entry.available ?? 0), 0);
		return {
			ok,
			probed,
			accounts,
			message: probed === 0 ? "no account to probe" : ok ? `probed ${String(probed)} account(s); ${String(known.length)} report points, ${total.toLocaleString("en-US")} available in total` : `points lookup failed: ${accounts.find((entry) => !entry.ok)?.message ?? "unknown"}`
		};
	};
	/** 手动/自动刷新目录。 */
	const refreshModels = async () => {
		await syncPool();
		const outcome = await refreshCatalog(store, catalog);
		return {
			models: catalog.current().length,
			refreshed: outcome.anySucceeded
		};
	};
	/** 账号变动之后统一收口：对齐池、复活、补目录与点数。 */
	const afterAccountChange = async () => {
		await syncPool();
		refreshCatalog(store, catalog).catch(() => {});
		refreshPoints().catch(() => {});
	};
	/** provider 是否真的挂上了 —— 卡片体检要能看到这一条（注册失败时它会是 false）。 */
	let providerRegistered = false;
	const shim = createLoomyShim({
		store,
		pool,
		catalog,
		usage,
		points,
		enabledModels: () => current().enabledModels,
		logger: ctx.logger
	});
	let stopped = false;
	ctx.inject(["webServer"], (webCtx) => {
		registerLoomyStatusRoutes(webCtx, {
			store,
			models: () => catalog.current(),
			enabledModels: () => current().enabledModels,
			setEnabledModels,
			pool: () => pool.list(),
			strategy: () => pool.currentStrategy(),
			reviveAccount: (id) => pool.revive(id),
			afterAccountChange,
			usage: () => usage.snapshot(),
			points: () => points.snapshot(),
			refreshPoints,
			dock,
			setDock,
			refreshModels,
			shimStats: () => shim.stats(),
			providerRegistered: () => providerRegistered,
			version: LOOMY_VERSION,
			pointsNote: POINTS_NOTE
		});
	});
	installSettingsSectionCompat(ctx, LOOMY_SETTINGS_NS, Config, config, {
		setSource(source) {
			current = () => unwrapConfig(source());
			syncPool().catch(() => {});
		},
		onChange() {
			syncPool().catch(() => {});
		}
	});
	const CATALOG_REFRESH_MS = 36e5;
	/** 目录空时的重试（指数退避，封顶 5 分钟）。 */
	const CATALOG_EMPTY_RETRY_MS = 6e4;
	const CATALOG_EMPTY_RETRY_MAX_MS = 3e5;
	let discoveryTimer;
	let emptyStreak = 0;
	const abort = new AbortController();
	const discoverLoop = async () => {
		if (stopped) return;
		try {
			await syncPool();
			const outcome = await refreshCatalog(store, catalog, abort.signal);
			if (outcome.anySucceeded) ctx.logger.debug(`dsh-loomy: model catalog refreshed (${String(outcome.models.length)} models)`);
			else if ((await store.ids()).length > 0) ctx.logger.debug("dsh-loomy: model discovery found nothing usable; keeping the current catalog");
		} catch (error) {
			ctx.logger.debug("dsh-loomy: model discovery failed; keeping the current catalog", error);
		}
		if (stopped) return;
		let delay;
		if (catalog.current().length === 0) {
			delay = Math.min(CATALOG_EMPTY_RETRY_MS * 2 ** emptyStreak, CATALOG_EMPTY_RETRY_MAX_MS);
			emptyStreak += 1;
		} else {
			emptyStreak = 0;
			delay = CATALOG_REFRESH_MS;
		}
		discoveryTimer = setTimeout(() => void discoverLoop(), delay);
		discoveryTimer.unref?.();
	};
	/**
	* 每 6 小时检查一次「会话快到期」的账号。
	*
	* 会话寿命 14 天、提前 3 天续；6 小时的粒度足够，而且不会让上游觉得我们在刷登录接口。
	* 没有密码的账号无法续期，这里只把它暴露出来（卡片会显示剩余天数）。
	*/
	const KEEP_ALIVE_INTERVAL_MS = 216e5;
	let keepAliveTimer;
	const keepAliveLoop = async () => {
		if (stopped) return;
		try {
			if (current().autoRenew !== false) {
				const outcome = await store.keepAlive();
				if (outcome.refreshed > 0) ctx.logger.debug(`dsh-loomy: renewed ${String(outcome.refreshed)} session(s)`);
				if (outcome.needsLogin.length > 0) ctx.logger.debug(`dsh-loomy: ${String(outcome.needsLogin.length)} account(s) need a fresh sign-in`);
			}
		} catch (error) {
			ctx.logger.debug("dsh-loomy: session keep-alive failed; will retry", error);
		}
		if (stopped) return;
		keepAliveTimer = setTimeout(() => void keepAliveLoop(), KEEP_ALIVE_INTERVAL_MS);
		keepAliveTimer.unref?.();
	};
	/** 点数变化不快，30 分钟一次足够；首次延迟 20 秒，别和启动瞬间抢上游。 */
	const POINTS_FIRST_DELAY_MS = 2e4;
	const POINTS_REFRESH_MS = 18e5;
	let pointsTimer;
	const pointsLoop = async () => {
		if (stopped) return;
		try {
			await refreshPoints();
		} catch (error) {
			ctx.logger.debug("dsh-loomy: points refresh failed; keeping the last numbers", error);
		}
		if (stopped) return;
		pointsTimer = setTimeout(() => void pointsLoop(), POINTS_REFRESH_MS);
		pointsTimer.unref?.();
	};
	usage.load().catch(() => {});
	ctx.effect(() => () => {
		stopped = true;
		abort.abort();
		for (const timer of [
			discoveryTimer,
			keepAliveTimer,
			pointsTimer
		]) if (timer !== void 0) clearTimeout(timer);
		usage.flush().catch(() => {});
		shim.close().catch(() => {});
	});
	shim.ready.then(async () => {
		if (stopped) return;
		await syncPool();
		discoverLoop();
		keepAliveLoop();
		pointsTimer = setTimeout(() => void pointsLoop(), POINTS_FIRST_DELAY_MS);
		pointsTimer.unref?.();
		const loomy = createLoomyAdapter({
			shim,
			catalog,
			enabledModels: () => current().enabledModels,
			resolveAttachments: () => ctx.get("attachments")
		});
		let releaseAdapter;
		let releaseDirectory;
		try {
			releaseAdapter = ctx.llm.registerAdapter([LOOMY_PROVIDER], loomy.adapter);
			releaseDirectory = ctx.llm.registerConfigurableProviders([{
				provider: LOOMY_PROVIDER,
				displayName: "Loomy",
				settingsNs: settingsCompatNamespace(ctx),
				settingsPath: [],
				declared: false
			}]);
		} finally {
			if (releaseAdapter === void 0 || releaseDirectory === void 0) {
				releaseAdapter?.();
				releaseDirectory?.();
			}
		}
		try {
			ctx.effect(() => () => {
				releaseAdapter?.();
				releaseDirectory?.();
			});
		} catch {
			releaseAdapter?.();
			releaseDirectory?.();
		}
		providerRegistered = true;
		ctx.logger.debug(`dsh-loomy: provider "${LOOMY_PROVIDER}" registered (shim on ${shim.baseUrl()})`);
	}).catch((error) => {
		ctx.logger.error("dsh-loomy: loopback shim failed to start; provider not registered", error);
	});
}
export { AccountService, Config, LOOMY_PROVIDER, LOOMY_SETTINGS_NS, LOOMY_VERSION, LoginError, LoomyAccountPool, LoomyAccountStore, LoomyCatalog, LoomyPointsTracker, LoomyQueueGate, LoomyUsageTracker, POINTS_NOTE, apply, buildAccountHeaders, createLoomyAdapter, createLoomyShim, discoverModels, fetchModels, filterEnabledModels, inject, looksLikeQuotaExhausted, loomyAccountsPath, loomyUsagePath, mergeModelLists, name, newIdentity, parseModelsPayload, parsePoints, refreshCatalog, rsaEncrypt, sign, stringToSign, summarizeAccount };
