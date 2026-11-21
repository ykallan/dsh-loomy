/// <reference types="node" />
import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { Context } from "@deepseek-ai/cordis";
import { URL as URL$1, URLSearchParams as URLSearchParams$1 } from "url";
import { Duplex, Readable, Writable } from "stream";
import { EventEmitter } from "events";
import { Blob as Blob$1 } from "buffer";
import { ConnectionOptions, TLSSocket } from "tls";
import { IpcNetConnectOpts, Socket, TcpNetConnectOpts } from "net";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
/** 选号策略。 */
type PoolStrategy = 'balance' | 'round_robin' | 'lru';
/** 池里一个账号的运行时状态。 */
interface AccountRuntime {
  id: string;
  /** 我们这边正在飞的请求数。 */
  activeConcurrent: number;
  maxConcurrent: number;
  /** 冷却截止时间（epoch ms）；0 = 没在冷却。 */
  coolUntil: number;
  /** 凭据失效等硬错误：停用，等用户重新登录。 */
  disabled: boolean;
  lastError?: string;
  /** 上次被选中的时间，用于「最久未用优先」。 */
  lastUsed: number;
  errorCount: number;
}
interface PoolOptions {
  maxConcurrent?: number;
  /** 选号策略，缺省 `balance`。 */
  strategy?: PoolStrategy;
  /** 额度读数（点数）；`undefined` = 不知道。 */
  available?: (id: string) => number | undefined;
  /** 可注入的时钟，便于测试。 */
  now?: () => number;
}
declare class LoomyAccountPool {
  private readonly accounts;
  /** 用户手动暂停的账号：运行时状态留着（卡片还看得见槽位），但不参与轮转。 */
  private readonly paused;
  /** 用户置顶的账号：选号时排在最前面。 */
  private readonly preferred;
  private readonly maxConcurrent;
  private readonly now;
  private readonly available;
  /** 等槽位的唤醒器。 */
  private readonly waiters;
  private strategy;
  /** 轮转游标（`round_robin`）。 */
  private cursor;
  constructor(ids: readonly string[], options?: PoolOptions);
  /** 切策略（配置变更时）。 */
  setStrategy(strategy: PoolStrategy): void;
  currentStrategy(): PoolStrategy;
  /** 让池与账号文档对齐：新增的进来，删掉的出去。已有账号的运行时状态保留。 */
  sync(ids: readonly string[]): void;
  list(): AccountRuntime[];
  get(id: string): AccountRuntime | undefined;
  /** 账号本身可用（没被禁用、不在冷却中）。 */
  healthy(id: string): boolean;
  /** 现在就能接活的账号，按策略排好序。 */
  private available_;
  /** 设置暂停集合（账号 id）。 */
  setPaused(ids: readonly string[]): void;
  pausedIds(): string[];
  /** 设置置顶集合（账号 id）。置顶只在「同时可用」时改变先后，不绕过冷却/上限。 */
  setPreferred(ids: readonly string[]): void;
  preferredIds(): string[];
  /** 选一个账号（跳过 `exclude` 里的）。 */
  pick(exclude?: ReadonlySet<string>): string | undefined;
  /** 占一个本地槽位。占用失败（已满/不存在）返回 false。 */
  acquire(id: string): boolean;
  /** 释放槽位；重复释放不会把计数压到负数。 */
  release(id: string): void;
  private notifyWaiters;
  /** 现在是否有一个真正能接活的空槽位。 */
  hasFreeSlot(): boolean;
  /** 有没有「健康、但本地槽位被占满」的号 —— 只有这种值得等一会儿。 */
  hasBusyWaitable(): boolean;
  /** 等一个本地槽位空出来，最多 `maxWaitMs`。 */
  waitForFreeSlot(maxWaitMs: number, signal?: AbortSignal): Promise<boolean>;
  /** 凭据失效等硬错误：直接停用，等用户重新登录。 */
  disable(id: string, reason: string): void;
  /** 用户重新登录后调用：把账号从禁用/冷却里捞出来。 */
  revive(id: string): void;
  /** 上游 5xx / 软限流：短时冷却。 */
  cooldown(id: string, ms: number, reason: string): void;
  /** 累计错误；达到阈值就冷却。 */
  noteError(id: string, threshold: number, cooldownMs: number, reason: string): void;
  /** 一次成功：清掉错误计数与冷却。 */
  noteSuccess(id: string): void;
  /** 有没有任何账号可用（含被暂停之外的）。 */
  hasUsable(): boolean;
}
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
/** 上游声明的思考强度。 */
interface LoomyModelThinking {
  /** 可选档位（`reasoning_efforts` 的原值）。 */
  levels: readonly string[];
  /** 上游默认档位。 */
  default?: string;
}
/** 一个暴露给 DSH 的模型。 */
interface LoomyModelInfo {
  /** 模型 id —— 与上游 wire id 相同（不做别名映射）。 */
  id: string;
  /** 展示名（上游 `name`，里面有 `x0.8` 这样的点数倍率）。 */
  name: string;
  contextWindow: number;
  /** `contextWindow` 是上游真的给的，还是兜底值。卡片只在真值时印规格。 */
  contextWindowKnown?: boolean;
  maxTokens: number;
  supportsImages: boolean;
  /** 是不是思考模型（`capabilities.reasoning`）。 */
  reasoning?: boolean;
  /** 支持工具调用（`capabilities.function_calling`）。 */
  toolCall?: boolean;
  /** 上游声明支持流式（`capabilities.streaming`）。 */
  streaming?: boolean;
  /** 上游声明的思考档位。空/缺省 = 不显示推理档位选择器。 */
  thinking?: LoomyModelThinking;
  /** 点数倍率（上游 `name` 里的 `x0.8`）。只展示，不参与路由。 */
  multiplier?: number;
}
/** 可变目录，由 shim 的 `/v1/models` 与适配器共享。 */
declare class LoomyCatalog {
  /** 空目录起步：没发现过就是没有模型。 */
  private models;
  current(): readonly LoomyModelInfo[];
  set(models: readonly LoomyModelInfo[]): void;
  /** 按 id 找一条（大小写不敏感，接受 `imodel/` 前缀）。 */
  find(id: string): LoomyModelInfo | undefined;
}
/**
 * 把目录收窄到用户勾选的模型。
 *
 * 三种**模式**（不是「空数组 = 全部」这种单一约定）：
 *
 * | mode | enabled 的含义 | 结果 |
 * |---|---|---|
 * | `all` | 忽略 | 目录全给（缺省） |
 * | `none` | 忽略 | 一个都不给 |
 * | `custom` | 勾选的 id | 只给勾选的 |
 *
 * 为什么不能只用 `enabledModels` 一个字段：**「全选」和「全不选」都是空数组**，无法区分。
 * 有了显式模式，卡片上的「全选 / 反选」才是一对可逆的操作（反选全选的结果必须真的是
 * 「一个都不给」，而不是又变回全选）。
 *
 * `custom` 且没有一个 id 命中目录时**退回全给**：目录刚刷新、勾选项对不上时，把模型选择器
 * 直接清空比让它凭空消失要安全。
 */
type SelectionMode = 'all' | 'none' | 'custom';
/** 一次模型勾选选择。 */
interface Selection {
  mode: SelectionMode;
  /** 仅 `custom` 时有意义；其余模式忽略。 */
  enabled: readonly string[];
}
/** 是否是个合法的模式值（卡片/路由收到的字符串要过这一关）。 */
declare function isSelectionMode(value: unknown): value is SelectionMode;
/**
 * 由配置里的 `enabledModels`（可能没有显式模式）归一成一份 `Selection`。
 *
 * 缺省兼容旧配置：没写模式时，空数组 = 全给、非空 = 自定义。
 */
declare function normalizeSelection(enabled: readonly string[] | undefined, mode?: SelectionMode): Selection;
/** 按选择算出真正暴露的模型。 */
declare function resolveSelection(models: readonly LoomyModelInfo[], selection: Selection): readonly LoomyModelInfo[];
/**
 * 反选：把「当前暴露的」翻成「当前没暴露的」。
 *
 * 这是卡片「反选」按钮唯一要算的东西，放在这里是为了让语义在宿主与浏览器之间只有一份。
 *
 * @returns 新的选择（含模式，`enabled` 已按 `custom` 的口径整理好）。
 */
declare function invertSelection(models: readonly LoomyModelInfo[], selection: Selection): Selection;
/** 把目录收窄到用户勾选的模型（带模式；只传数组时按旧约定推断）。 */
declare function filterEnabledModels(models: readonly LoomyModelInfo[], enabled: readonly string[] | undefined, mode?: SelectionMode): readonly LoomyModelInfo[];
/**
 * 合并多路来源（多账号）的模型清单。
 *
 * 规则：
 *  - 按 id 去重（大小写不敏感）；
 *  - 参数更全的一条优先（有真窗口 > 兜底窗口，支持图片 > 不支持）；
 *  - 输出按 id 排序，保证刷新前后顺序稳定。
 */
declare function mergeModelLists(sets: readonly (readonly LoomyModelInfo[])[]): readonly LoomyModelInfo[];
/**
 * The header type declaration of `undici`.
 */
type IncomingHttpHeaders = Record<string, string | string[] | undefined>;
declare class BodyReadable extends Readable {
  constructor(resume?: (this: Readable, size: number) => void | null, abort?: () => void | null, contentType?: string);
  /** Consumes and returns the body as a string
   *  https://fetch.spec.whatwg.org/#dom-body-text
   */
  text(): Promise<string>;
  /** Consumes and returns the body as a JavaScript Object
   *  https://fetch.spec.whatwg.org/#dom-body-json
   */
  json(): Promise<unknown>;
  /** Consumes and returns the body as a Blob
   *  https://fetch.spec.whatwg.org/#dom-body-blob
   */
  blob(): Promise<Blob$1>;
  /** Consumes and returns the body as an Uint8Array
   *  https://fetch.spec.whatwg.org/#dom-body-bytes
   */
  bytes(): Promise<Uint8Array>;
  /** Consumes and returns the body as an ArrayBuffer
   *  https://fetch.spec.whatwg.org/#dom-body-arraybuffer
   */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Not implemented
   *
   *  https://fetch.spec.whatwg.org/#dom-body-formdata
   */
  formData(): Promise<never>;
  /** Returns true if the body is not null and the body has been consumed
   *
   *  Otherwise, returns false
   *
   * https://fetch.spec.whatwg.org/#dom-body-bodyused
   */
  readonly bodyUsed: boolean;
  /**
   * If body is null, it should return null as the body
   *
   *  If body is not null, should return the body as a ReadableStream
   *
   *  https://fetch.spec.whatwg.org/#dom-body-body
   */
  readonly body: never | undefined;
  /** Dumps the response body by reading `limit` number of bytes.
   * @param opts.limit Number of bytes to read (optional) - Default: 262144
   */
  dump(opts?: {
    limit: number;
  }): Promise<void>;
}
interface BlobPropertyBag {
  type?: string;
  endings?: 'native' | 'transparent';
}
interface FilePropertyBag extends BlobPropertyBag {
  /**
   * The last modified date of the file as the number of milliseconds since the Unix epoch (January 1, 1970 at midnight). Files without a known last modified date return the current date.
   */
  lastModified?: number;
}
declare class File$1 extends Blob$1 {
  /**
   * Creates a new File instance.
   *
   * @param fileBits An `Array` strings, or [`ArrayBuffer`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer), [`ArrayBufferView`](https://developer.mozilla.org/en-US/docs/Web/API/ArrayBufferView), [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob) objects, or a mix of any of such objects, that will be put inside the [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File).
   * @param fileName The name of the file.
   * @param options An options object containing optional attributes for the file.
   */
  constructor(fileBits: ReadonlyArray<string | NodeJS.ArrayBufferView | Blob$1>, fileName: string, options?: FilePropertyBag);
  /**
   * Name of the file referenced by the File object.
   */
  readonly name: string;
  /**
   * The last modified date of the file as the number of milliseconds since the Unix epoch (January 1, 1970 at midnight). Files without a known last modified date return the current date.
   */
  readonly lastModified: number;
  readonly [Symbol.toStringTag]: string;
}
type BodyInit = ArrayBuffer | AsyncIterable<Uint8Array> | Blob$1 | FormData$1 | Iterable<Uint8Array> | NodeJS.ArrayBufferView | URLSearchParams$1 | null | string;
interface SpecIterator<T, TReturn = any, TNext = undefined> {
  next(...args: [] | [TNext]): IteratorResult<T, TReturn>;
}
interface SpecIterableIterator<T> extends SpecIterator<T> {
  [Symbol.iterator](): SpecIterableIterator<T>;
}
interface SpecIterable<T> {
  [Symbol.iterator](): SpecIterator<T>;
}
type HeadersInit$1 = string[][] | Record<string, string | ReadonlyArray<string>> | Headers$1;
declare class Headers$1 implements SpecIterable<[string, string]> {
  constructor(init?: HeadersInit$1);
  readonly append: (name: string, value: string) => void;
  readonly delete: (name: string) => void;
  readonly get: (name: string) => string | null;
  readonly has: (name: string) => boolean;
  readonly set: (name: string, value: string) => void;
  readonly getSetCookie: () => string[];
  readonly forEach: (callbackfn: (value: string, key: string, iterable: Headers$1) => void, thisArg?: unknown) => void;
  readonly keys: () => SpecIterableIterator<string>;
  readonly values: () => SpecIterableIterator<string>;
  readonly entries: () => SpecIterableIterator<[string, string]>;
  readonly [Symbol.iterator]: () => SpecIterableIterator<[string, string]>;
}
/**
 * A `string` or `File` that represents a single value from a set of `FormData` key-value pairs.
 */
declare type FormDataEntryValue = string | File$1;
/**
 * Provides a way to easily construct a set of key/value pairs representing form fields and their values, which can then be easily sent using fetch().
 */
declare class FormData$1 {
  /**
   * Appends a new value onto an existing key inside a FormData object,
   * or adds the key if it does not already exist.
   *
   * The difference between `set()` and `append()` is that if the specified key already exists, `set()` will overwrite all existing values with the new one, whereas `append()` will append the new value onto the end of the existing set of values.
   *
   * @param name The name of the field whose data is contained in `value`.
   * @param value The field's value. This can be [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob)
    or [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File). If none of these are specified the value is converted to a string.
   * @param fileName The filename reported to the server, when a Blob or File is passed as the second parameter. The default filename for Blob objects is "blob". The default filename for File objects is the file's filename.
   */
  append(name: string, value: unknown, fileName?: string): void;
  /**
   * Set a new value for an existing key inside FormData,
   * or add the new field if it does not already exist.
   *
   * @param name The name of the field whose data is contained in `value`.
   * @param value The field's value. This can be [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob)
    or [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File). If none of these are specified the value is converted to a string.
   * @param fileName The filename reported to the server, when a Blob or File is passed as the second parameter. The default filename for Blob objects is "blob". The default filename for File objects is the file's filename.
   *
   */
  set(name: string, value: unknown, fileName?: string): void;
  /**
   * Returns the first value associated with a given key from within a `FormData` object.
   * If you expect multiple values and want all of them, use the `getAll()` method instead.
   *
   * @param {string} name A name of the value you want to retrieve.
   *
   * @returns A `FormDataEntryValue` containing the value. If the key doesn't exist, the method returns null.
   */
  get(name: string): FormDataEntryValue | null;
  /**
   * Returns all the values associated with a given key from within a `FormData` object.
   *
   * @param {string} name A name of the value you want to retrieve.
   *
   * @returns An array of `FormDataEntryValue` whose key matches the value passed in the `name` parameter. If the key doesn't exist, the method returns an empty list.
   */
  getAll(name: string): FormDataEntryValue[];
  /**
   * Returns a boolean stating whether a `FormData` object contains a certain key.
   *
   * @param name A string representing the name of the key you want to test for.
   *
   * @return A boolean value.
   */
  has(name: string): boolean;
  /**
   * Deletes a key and its value(s) from a `FormData` object.
   *
   * @param name The name of the key you want to delete.
   */
  delete(name: string): void;
  /**
   * Executes given callback function for each field of the FormData instance
   */
  forEach: (callbackfn: (value: FormDataEntryValue, key: string, iterable: FormData$1) => void, thisArg?: unknown) => void;
  /**
   * Returns an [`iterator`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols) allowing to go through all keys contained in this `FormData` object.
   * Each key is a `string`.
   */
  keys: () => SpecIterableIterator<string>;
  /**
   * Returns an [`iterator`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols) allowing to go through all values contained in this object `FormData` object.
   * Each value is a [`FormDataValue`](https://developer.mozilla.org/en-US/docs/Web/API/FormDataEntryValue).
   */
  values: () => SpecIterableIterator<FormDataEntryValue>;
  /**
   * Returns an [`iterator`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols) allowing to go through the `FormData` key/value pairs.
   * The key of each pair is a string; the value is a [`FormDataValue`](https://developer.mozilla.org/en-US/docs/Web/API/FormDataEntryValue).
   */
  entries: () => SpecIterableIterator<[string, FormDataEntryValue]>;
  /**
   * An alias for FormData#entries()
   */
  [Symbol.iterator]: () => SpecIterableIterator<[string, FormDataEntryValue]>;
  readonly [Symbol.toStringTag]: string;
}
declare function buildConnector(options?: buildConnector.BuildOptions): buildConnector.connector;
declare namespace buildConnector {
  export type BuildOptions = (ConnectionOptions | TcpNetConnectOpts | IpcNetConnectOpts) & {
    allowH2?: boolean;
    maxCachedSessions?: number | null;
    socketPath?: string | null;
    timeout?: number | null;
    port?: number;
    keepAlive?: boolean | null;
    keepAliveInitialDelay?: number | null;
  };
  export interface Options {
    hostname: string;
    host?: string;
    protocol: string;
    port: string;
    servername?: string;
    localAddress?: string | null;
    httpSocket?: Socket;
  }
  export type Callback = (...args: CallbackArgs) => void;
  type CallbackArgs = [null, Socket | TLSSocket] | [Error, null];
  export interface connector {
    (options: buildConnector.Options, callback: buildConnector.Callback): void;
  }
}
type ClientConnectOptions = Omit<Dispatcher.ConnectOptions, "origin">;
/**
 * A basic HTTP/1.1 client, mapped on top a single TCP/TLS connection. Pipelining is disabled by default.
 */
declare class Client extends Dispatcher {
  constructor(url: string | URL$1, options?: Client.Options);
  /** Property to get and set the pipelining factor. */
  pipelining: number;
  /** `true` after `client.close()` has been called. */
  closed: boolean;
  /** `true` after `client.destroyed()` has been called or `client.close()` has been called and the client shutdown has completed. */
  destroyed: boolean;
  // Override dispatcher APIs.
  override connect(options: ClientConnectOptions): Promise<Dispatcher.ConnectData>;
  override connect(options: ClientConnectOptions, callback: (err: Error | null, data: Dispatcher.ConnectData) => void): void;
}
declare namespace Client {
  export interface OptionsInterceptors {
    Client: readonly Dispatcher.DispatchInterceptor[];
  }
  export interface Options {
    /** TODO */
    interceptors?: OptionsInterceptors;
    /** The maximum length of request headers in bytes. Default: Node.js' `--max-http-header-size` or `16384` (16KiB). */
    maxHeaderSize?: number;
    /** The amount of time, in milliseconds, the parser will wait to receive the complete HTTP headers (Node 14 and above only). Default: `300e3` milliseconds (300s). */
    headersTimeout?: number;
    /** @deprecated unsupported socketTimeout, use headersTimeout & bodyTimeout instead */
    socketTimeout?: never;
    /** @deprecated unsupported requestTimeout, use headersTimeout & bodyTimeout instead */
    requestTimeout?: never;
    /** TODO */
    connectTimeout?: number;
    /** The timeout after which a request will time out, in milliseconds. Monitors time between receiving body data. Use `0` to disable it entirely. Default: `300e3` milliseconds (300s). */
    bodyTimeout?: number;
    /** @deprecated unsupported idleTimeout, use keepAliveTimeout instead */
    idleTimeout?: never;
    /** @deprecated unsupported keepAlive, use pipelining=0 instead */
    keepAlive?: never;
    /** the timeout, in milliseconds, after which a socket without active requests will time out. Monitors time between activity on a connected socket. This value may be overridden by *keep-alive* hints from the server. Default: `4e3` milliseconds (4s). */
    keepAliveTimeout?: number;
    /** @deprecated unsupported maxKeepAliveTimeout, use keepAliveMaxTimeout instead */
    maxKeepAliveTimeout?: never;
    /** the maximum allowed `idleTimeout`, in milliseconds, when overridden by *keep-alive* hints from the server. Default: `600e3` milliseconds (10min). */
    keepAliveMaxTimeout?: number;
    /** A number of milliseconds subtracted from server *keep-alive* hints when overriding `idleTimeout` to account for timing inaccuracies caused by e.g. transport latency. Default: `1e3` milliseconds (1s). */
    keepAliveTimeoutThreshold?: number;
    /** TODO */
    socketPath?: string;
    /** The amount of concurrent requests to be sent over the single TCP/TLS connection according to [RFC7230](https://tools.ietf.org/html/rfc7230#section-6.3.2). Default: `1`. */
    pipelining?: number;
    /** @deprecated use the connect option instead */
    tls?: never;
    /** If `true`, an error is thrown when the request content-length header doesn't match the length of the request body. Default: `true`. */
    strictContentLength?: boolean;
    /** TODO */
    maxCachedSessions?: number;
    /** TODO */
    maxRedirections?: number;
    /** TODO */
    connect?: buildConnector.BuildOptions | buildConnector.connector;
    /** TODO */
    maxRequestsPerClient?: number;
    /** TODO */
    localAddress?: string;
    /** Max response body size in bytes, -1 is disabled */
    maxResponseSize?: number;
    /** Enables a family autodetection algorithm that loosely implements section 5 of RFC 8305. */
    autoSelectFamily?: boolean;
    /** The amount of time in milliseconds to wait for a connection attempt to finish before trying the next address when using the `autoSelectFamily` option. */
    autoSelectFamilyAttemptTimeout?: number;
    /**
     * @description Enables support for H2 if the server has assigned bigger priority to it through ALPN negotiation.
     * @default false
     */
    allowH2?: boolean;
    /**
     * @description Dictates the maximum number of concurrent streams for a single H2 session. It can be overridden by a SETTINGS remote frame.
     * @default 100
     */
    maxConcurrentStreams?: number;
  }
  export interface SocketInfo {
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
    timeout?: number;
    bytesWritten?: number;
    bytesRead?: number;
  }
}
declare namespace Errors {
  export class UndiciError extends Error {
    name: string;
    code: string;
  }
  /** Connect timeout error. */
  export class ConnectTimeoutError extends UndiciError {
    name: 'ConnectTimeoutError';
    code: 'UND_ERR_CONNECT_TIMEOUT';
  }
  /** A header exceeds the `headersTimeout` option. */
  export class HeadersTimeoutError extends UndiciError {
    name: 'HeadersTimeoutError';
    code: 'UND_ERR_HEADERS_TIMEOUT';
  }
  /** Headers overflow error. */
  export class HeadersOverflowError extends UndiciError {
    name: 'HeadersOverflowError';
    code: 'UND_ERR_HEADERS_OVERFLOW';
  }
  /** A body exceeds the `bodyTimeout` option. */
  export class BodyTimeoutError extends UndiciError {
    name: 'BodyTimeoutError';
    code: 'UND_ERR_BODY_TIMEOUT';
  }
  export class ResponseStatusCodeError extends UndiciError {
    constructor(message?: string, statusCode?: number, headers?: IncomingHttpHeaders | string[] | null, body?: null | Record<string, any> | string);
    name: 'ResponseStatusCodeError';
    code: 'UND_ERR_RESPONSE_STATUS_CODE';
    body: null | Record<string, any> | string;
    status: number;
    statusCode: number;
    headers: IncomingHttpHeaders | string[] | null;
  }
  /** Passed an invalid argument. */
  export class InvalidArgumentError extends UndiciError {
    name: 'InvalidArgumentError';
    code: 'UND_ERR_INVALID_ARG';
  }
  /** Returned an invalid value. */
  export class InvalidReturnValueError extends UndiciError {
    name: 'InvalidReturnValueError';
    code: 'UND_ERR_INVALID_RETURN_VALUE';
  }
  /** The request has been aborted by the user. */
  export class RequestAbortedError extends UndiciError {
    name: 'AbortError';
    code: 'UND_ERR_ABORTED';
  }
  /** Expected error with reason. */
  export class InformationalError extends UndiciError {
    name: 'InformationalError';
    code: 'UND_ERR_INFO';
  }
  /** Request body length does not match content-length header. */
  export class RequestContentLengthMismatchError extends UndiciError {
    name: 'RequestContentLengthMismatchError';
    code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH';
  }
  /** Response body length does not match content-length header. */
  export class ResponseContentLengthMismatchError extends UndiciError {
    name: 'ResponseContentLengthMismatchError';
    code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH';
  }
  /** Trying to use a destroyed client. */
  export class ClientDestroyedError extends UndiciError {
    name: 'ClientDestroyedError';
    code: 'UND_ERR_DESTROYED';
  }
  /** Trying to use a closed client. */
  export class ClientClosedError extends UndiciError {
    name: 'ClientClosedError';
    code: 'UND_ERR_CLOSED';
  }
  /** There is an error with the socket. */
  export class SocketError extends UndiciError {
    name: 'SocketError';
    code: 'UND_ERR_SOCKET';
    socket: Client.SocketInfo | null;
  }
  /** Encountered unsupported functionality. */
  export class NotSupportedError extends UndiciError {
    name: 'NotSupportedError';
    code: 'UND_ERR_NOT_SUPPORTED';
  }
  /** No upstream has been added to the BalancedPool. */
  export class BalancedPoolMissingUpstreamError extends UndiciError {
    name: 'MissingUpstreamError';
    code: 'UND_ERR_BPL_MISSING_UPSTREAM';
  }
  export class HTTPParserError extends UndiciError {
    name: 'HTTPParserError';
    code: string;
  }
  /** The response exceed the length allowed. */
  export class ResponseExceededMaxSizeError extends UndiciError {
    name: 'ResponseExceededMaxSizeError';
    code: 'UND_ERR_RES_EXCEEDED_MAX_SIZE';
  }
  export class RequestRetryError extends UndiciError {
    constructor(message: string, statusCode: number, headers?: IncomingHttpHeaders | string[] | null, body?: null | Record<string, any> | string);
    name: 'RequestRetryError';
    code: 'UND_ERR_REQ_RETRY';
    statusCode: number;
    data: {
      count: number;
    };
    headers: Record<string, string | string[]>;
  }
  export class SecureProxyConnectionError extends UndiciError {
    name: 'SecureProxyConnectionError';
    code: 'UND_ERR_PRX_TLS';
  }
}
type AbortSignal$1 = unknown;
/** Dispatcher is the core API used to dispatch requests. */
declare class Dispatcher extends EventEmitter {
  /** Dispatches a request. This API is expected to evolve through semver-major versions and is less stable than the preceding higher level APIs. It is primarily intended for library developers who implement higher level APIs on top of this. */
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean;
  /** Starts two-way communications with the requested resource. */
  connect(options: Dispatcher.ConnectOptions): Promise<Dispatcher.ConnectData>;
  connect(options: Dispatcher.ConnectOptions, callback: (err: Error | null, data: Dispatcher.ConnectData) => void): void;
  /** Compose a chain of dispatchers */
  compose(dispatchers: Dispatcher.DispatcherComposeInterceptor[]): Dispatcher.ComposedDispatcher;
  compose(...dispatchers: Dispatcher.DispatcherComposeInterceptor[]): Dispatcher.ComposedDispatcher;
  /** Performs an HTTP request. */
  request(options: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData>;
  request(options: Dispatcher.RequestOptions, callback: (err: Error | null, data: Dispatcher.ResponseData) => void): void;
  /** For easy use with `stream.pipeline`. */
  pipeline(options: Dispatcher.PipelineOptions, handler: Dispatcher.PipelineHandler): Duplex;
  /** A faster version of `Dispatcher.request`. */
  stream(options: Dispatcher.RequestOptions, factory: Dispatcher.StreamFactory): Promise<Dispatcher.StreamData>;
  stream(options: Dispatcher.RequestOptions, factory: Dispatcher.StreamFactory, callback: (err: Error | null, data: Dispatcher.StreamData) => void): void;
  /** Upgrade to a different protocol. */
  upgrade(options: Dispatcher.UpgradeOptions): Promise<Dispatcher.UpgradeData>;
  upgrade(options: Dispatcher.UpgradeOptions, callback: (err: Error | null, data: Dispatcher.UpgradeData) => void): void;
  /** Closes the client and gracefully waits for enqueued requests to complete before invoking the callback (or returning a promise if no callback is provided). */
  close(): Promise<void>;
  close(callback: () => void): void;
  /** Destroy the client abruptly with the given err. All the pending and running requests will be asynchronously aborted and error. Waits until socket is closed before invoking the callback (or returning a promise if no callback is provided). Since this operation is asynchronously dispatched there might still be some progress on dispatched requests. */
  destroy(): Promise<void>;
  destroy(err: Error | null): Promise<void>;
  destroy(callback: () => void): void;
  destroy(err: Error | null, callback: () => void): void;
  on(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  on(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  on(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  on(eventName: 'drain', callback: (origin: URL$1) => void): this;
  once(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  once(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  once(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  once(eventName: 'drain', callback: (origin: URL$1) => void): this;
  off(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  off(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  off(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  off(eventName: 'drain', callback: (origin: URL$1) => void): this;
  addListener(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  addListener(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  addListener(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  addListener(eventName: 'drain', callback: (origin: URL$1) => void): this;
  removeListener(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  removeListener(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  removeListener(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  removeListener(eventName: 'drain', callback: (origin: URL$1) => void): this;
  prependListener(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  prependListener(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  prependListener(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  prependListener(eventName: 'drain', callback: (origin: URL$1) => void): this;
  prependOnceListener(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  prependOnceListener(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  prependOnceListener(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  prependOnceListener(eventName: 'drain', callback: (origin: URL$1) => void): this;
  listeners(eventName: 'connect'): ((origin: URL$1, targets: readonly Dispatcher[]) => void)[];
  listeners(eventName: 'disconnect'): ((origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void)[];
  listeners(eventName: 'connectionError'): ((origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void)[];
  listeners(eventName: 'drain'): ((origin: URL$1) => void)[];
  rawListeners(eventName: 'connect'): ((origin: URL$1, targets: readonly Dispatcher[]) => void)[];
  rawListeners(eventName: 'disconnect'): ((origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void)[];
  rawListeners(eventName: 'connectionError'): ((origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void)[];
  rawListeners(eventName: 'drain'): ((origin: URL$1) => void)[];
  emit(eventName: 'connect', origin: URL$1, targets: readonly Dispatcher[]): boolean;
  emit(eventName: 'disconnect', origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError): boolean;
  emit(eventName: 'connectionError', origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError): boolean;
  emit(eventName: 'drain', origin: URL$1): boolean;
}
declare namespace Dispatcher {
  export interface ComposedDispatcher extends Dispatcher {}
  export type DispatcherComposeInterceptor = (dispatch: Dispatcher['dispatch']) => Dispatcher['dispatch'];
  export interface DispatchOptions {
    origin?: string | URL$1;
    path: string;
    method: HttpMethod;
    /** Default: `null` */
    body?: string | Buffer | Uint8Array | Readable | null | FormData$1;
    /** Default: `null` */
    headers?: IncomingHttpHeaders | string[] | Iterable<[string, string | string[] | undefined]> | null;
    /** Query string params to be embedded in the request URL. Default: `null` */
    query?: Record<string, any>;
    /** Whether the requests can be safely retried or not. If `false` the request won't be sent until all preceding requests in the pipeline have completed. Default: `true` if `method` is `HEAD` or `GET`. */
    idempotent?: boolean;
    /** Whether the response is expected to take a long time and would end up blocking the pipeline. When this is set to `true` further pipelining will be avoided on the same connection until headers have been received. */
    blocking?: boolean;
    /** Upgrade the request. Should be used to specify the kind of upgrade i.e. `'Websocket'`. Default: `method === 'CONNECT' || null`. */
    upgrade?: boolean | string | null;
    /** The amount of time, in milliseconds, the parser will wait to receive the complete HTTP headers. Defaults to 300 seconds. */
    headersTimeout?: number | null;
    /** The timeout after which a request will time out, in milliseconds. Monitors time between receiving body data. Use 0 to disable it entirely. Defaults to 300 seconds. */
    bodyTimeout?: number | null;
    /** Whether the request should stablish a keep-alive or not. Default `false` */
    reset?: boolean;
    /** Whether Undici should throw an error upon receiving a 4xx or 5xx response from the server. Defaults to false */
    throwOnError?: boolean;
    /** For H2, it appends the expect: 100-continue header, and halts the request body until a 100-continue is received from the remote server*/
    expectContinue?: boolean;
  }
  export interface ConnectOptions {
    origin: string | URL$1;
    path: string;
    /** Default: `null` */
    headers?: IncomingHttpHeaders | string[] | null;
    /** Default: `null` */
    signal?: AbortSignal$1 | EventEmitter | null;
    /** This argument parameter is passed through to `ConnectData` */
    opaque?: unknown;
    /** Default: 0 */
    maxRedirections?: number;
    /** Default: false */
    redirectionLimitReached?: boolean;
    /** Default: `null` */
    responseHeader?: 'raw' | null;
  }
  export interface RequestOptions extends DispatchOptions {
    /** Default: `null` */
    opaque?: unknown;
    /** Default: `null` */
    signal?: AbortSignal$1 | EventEmitter | null;
    /** Default: 0 */
    maxRedirections?: number;
    /** Default: false */
    redirectionLimitReached?: boolean;
    /** Default: `null` */
    onInfo?: (info: {
      statusCode: number;
      headers: Record<string, string | string[]>;
    }) => void;
    /** Default: `null` */
    responseHeader?: 'raw' | null;
    /** Default: `64 KiB` */
    highWaterMark?: number;
  }
  export interface PipelineOptions extends RequestOptions {
    /** `true` if the `handler` will return an object stream. Default: `false` */
    objectMode?: boolean;
  }
  export interface UpgradeOptions {
    path: string;
    /** Default: `'GET'` */
    method?: string;
    /** Default: `null` */
    headers?: IncomingHttpHeaders | string[] | null;
    /** A string of comma separated protocols, in descending preference order. Default: `'Websocket'` */
    protocol?: string;
    /** Default: `null` */
    signal?: AbortSignal$1 | EventEmitter | null;
    /** Default: 0 */
    maxRedirections?: number;
    /** Default: false */
    redirectionLimitReached?: boolean;
    /** Default: `null` */
    responseHeader?: 'raw' | null;
  }
  export interface ConnectData {
    statusCode: number;
    headers: IncomingHttpHeaders;
    socket: Duplex;
    opaque: unknown;
  }
  export interface ResponseData {
    statusCode: number;
    headers: IncomingHttpHeaders;
    body: BodyReadable & BodyMixin;
    trailers: Record<string, string>;
    opaque: unknown;
    context: object;
  }
  export interface PipelineHandlerData {
    statusCode: number;
    headers: IncomingHttpHeaders;
    opaque: unknown;
    body: BodyReadable;
    context: object;
  }
  export interface StreamData {
    opaque: unknown;
    trailers: Record<string, string>;
  }
  export interface UpgradeData {
    headers: IncomingHttpHeaders;
    socket: Duplex;
    opaque: unknown;
  }
  export interface StreamFactoryData {
    statusCode: number;
    headers: IncomingHttpHeaders;
    opaque: unknown;
    context: object;
  }
  export type StreamFactory = (data: StreamFactoryData) => Writable;
  export interface DispatchHandlers {
    /** Invoked before request is dispatched on socket. May be invoked multiple times when a request is retried when the request at the head of the pipeline fails. */
    onConnect?(abort: (err?: Error) => void): void;
    /** Invoked when an error has occurred. */
    onError?(err: Error): void;
    /** Invoked when request is upgraded either due to a `Upgrade` header or `CONNECT` method. */
    onUpgrade?(statusCode: number, headers: Buffer[] | string[] | null, socket: Duplex): void;
    /** Invoked when response is received, before headers have been read. **/
    onResponseStarted?(): void;
    /** Invoked when statusCode and headers have been received. May be invoked multiple times due to 1xx informational headers. */
    onHeaders?(statusCode: number, headers: Buffer[], resume: () => void, statusText: string): boolean;
    /** Invoked when response payload data is received. */
    onData?(chunk: Buffer): boolean;
    /** Invoked when response payload and trailers have been received and the request has completed. */
    onComplete?(trailers: string[] | null): void;
    /** Invoked when a body chunk is sent to the server. May be invoked multiple times for chunked requests */
    onBodySent?(chunkSize: number, totalBytesSent: number): void;
  }
  export type PipelineHandler = (data: PipelineHandlerData) => Readable;
  export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'CONNECT' | 'OPTIONS' | 'TRACE' | 'PATCH';
  /**
   * @link https://fetch.spec.whatwg.org/#body-mixin
   */
  interface BodyMixin {
    readonly body?: never;
    readonly bodyUsed: boolean;
    arrayBuffer(): Promise<ArrayBuffer>;
    blob(): Promise<Blob$1>;
    bytes(): Promise<Uint8Array>;
    formData(): Promise<never>;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }
  export interface DispatchInterceptor {
    (dispatch: Dispatcher['dispatch']): Dispatcher['dispatch'];
  }
}
/** The scope associated with a mock dispatch. */
declare class MockScope<TData extends object = object> {
  constructor(mockDispatch: MockInterceptor.MockDispatch<TData>);
  /** Delay a reply by a set amount of time in ms. */
  delay(waitInMs: number): MockScope<TData>;
  /** Persist the defined mock data for the associated reply. It will return the defined mock data indefinitely. */
  persist(): MockScope<TData>;
  /** Define a reply for a set amount of matching requests. */
  times(repeatTimes: number): MockScope<TData>;
}
/** The interceptor for a Mock. */
declare class MockInterceptor {
  constructor(options: MockInterceptor.Options, mockDispatches: MockInterceptor.MockDispatch[]);
  /** Mock an undici request with the defined reply. */
  reply<TData extends object = object>(replyOptionsCallback: MockInterceptor.MockReplyOptionsCallback<TData>): MockScope<TData>;
  reply<TData extends object = object>(statusCode: number, data?: TData | Buffer | string | MockInterceptor.MockResponseDataHandler<TData>, responseOptions?: MockInterceptor.MockResponseOptions): MockScope<TData>;
  /** Mock an undici request by throwing the defined reply error. */
  replyWithError<TError extends Error = Error>(error: TError): MockScope;
  /** Set default reply headers on the interceptor for subsequent mocked replies. */
  defaultReplyHeaders(headers: IncomingHttpHeaders): MockInterceptor;
  /** Set default reply trailers on the interceptor for subsequent mocked replies. */
  defaultReplyTrailers(trailers: Record<string, string>): MockInterceptor;
  /** Set automatically calculated content-length header on subsequent mocked replies. */
  replyContentLength(): MockInterceptor;
}
declare namespace MockInterceptor {
  /** MockInterceptor options. */
  export interface Options {
    /** Path to intercept on. */
    path: string | RegExp | ((path: string) => boolean);
    /** Method to intercept on. Defaults to GET. */
    method?: string | RegExp | ((method: string) => boolean);
    /** Body to intercept on. */
    body?: string | RegExp | ((body: string) => boolean);
    /** Headers to intercept on. */
    headers?: Record<string, string | RegExp | ((body: string) => boolean)> | ((headers: Record<string, string>) => boolean);
    /** Query params to intercept on */
    query?: Record<string, any>;
  }
  export interface MockDispatch<TData extends object = object, TError extends Error = Error> extends Options {
    times: number | null;
    persist: boolean;
    consumed: boolean;
    data: MockDispatchData<TData, TError>;
  }
  export interface MockDispatchData<TData extends object = object, TError extends Error = Error> extends MockResponseOptions {
    error: TError | null;
    statusCode?: number;
    data?: TData | string;
  }
  export interface MockResponseOptions {
    headers?: IncomingHttpHeaders;
    trailers?: Record<string, string>;
  }
  export interface MockResponseCallbackOptions {
    path: string;
    method: string;
    headers?: Headers$1 | Record<string, string>;
    origin?: string;
    body?: BodyInit | Dispatcher.DispatchOptions['body'] | null;
    maxRedirections?: number;
  }
  export type MockResponseDataHandler<TData extends object = object> = (opts: MockResponseCallbackOptions) => TData | Buffer | string;
  export type MockReplyOptionsCallback<TData extends object = object> = (opts: MockResponseCallbackOptions) => {
    statusCode: number;
    data?: TData | Buffer | string;
    responseOptions?: MockResponseOptions;
  };
}
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
/** 登录失败的分类，卡片按它给不同文案。 */
type LoginFailureKind = 'credentials' | 'sms' | 'network' | 'server';
/** 带分类的登录错误。 */
declare class LoginError extends Error {
  readonly kind: LoginFailureKind;
  constructor(kind: LoginFailureKind, message: string);
}
/** 每条请求信封里「这台设备是谁」的那几个字段。`traceid` 不在这里（每条请求都新生成）。 */
interface LoomyIdentity {
  /** 设备 id；`per_account` 模式下每个账号一个 `web-<16 hex>`。 */
  devid: string;
  ua: string;
  modelid: string;
  version: string;
  /** 促销设备的 id（只出现在 `/points/*` 的 body 里，聊天请求不带）。 */
  campusDeviceId?: string;
  /** 生成时间（epoch ms）。 */
  createdAt: number;
}
/** 设备标识的生成模式。 */
type IdentityMode = 'per_account' | 'client';
/** 造一个设备标识。 */
declare function newIdentity(mode?: IdentityMode, now?: number): LoomyIdentity;
/** 一次登录拿到的东西。 */
interface LoomyLoginResult {
  session: string;
  userid?: string;
  phone?: string;
  obtainedAt: number;
  expireAt: number;
}
/** `call()` 的可选项。 */
interface AccountCallOptions {
  /** 覆盖设备标识（不传就用缺省的客户端值）。 */
  identity?: LoomyIdentity;
  signal?: AbortSignal;
  timeoutMs?: number;
}
/** 一次性可注入的依赖（测试打本地假上游）。 */
interface AccountServiceOptions {
  baseUrl?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
/**
 * 账号服务客户端。
 *
 * `call()` 是所有路径的唯一出口：签名、信封、错误归类都在这里，别在别处再拼一次。
 */
declare class AccountService {
  private readonly baseUrl;
  private readonly akId;
  private readonly akSecret;
  private readonly timeoutMs;
  private readonly fetchImpl;
  constructor(options?: AccountServiceOptions);
  /** 请求信封的 `base` 字段。 */
  private envelope;
  /**
   * 发一个账号服务请求。
   *
   * body 为空时**不带** `Content-Type` 之外的 body，也不带 `Content-MD5`，
   * 但签名里的那一行仍然是空串（见 `signer.ts`）。
   */
  call(path: string, body: Record<string, unknown> | undefined, options?: AccountCallOptions): Promise<Record<string, unknown>>;
  /** `pukey`（base64 DER）与 `rcode`（服务端 nonce）。 */
  getPublicKey(options?: AccountCallOptions): Promise<{
    pukey: string;
    rcode: string;
  }>;
  /** 手机号 + 密码登录。 */
  loginByPassword(loginid: string, password: string, options?: AccountCallOptions): Promise<LoomyLoginResult>;
  /** 发短信验证码，返回 `msgid`（下一步要用）。 */
  sendSmsCode(phone: string, options?: AccountCallOptions): Promise<string>;
  /** 用验证码换会话。 */
  loginBySms(phone: string, code: string, msgid: string, options?: AccountCallOptions): Promise<LoomyLoginResult>;
  /** 用户信息（会话是否还有效的旁证）。 */
  baseInfo(session: string, options?: AccountCallOptions): Promise<Record<string, unknown>>;
  /** 主动登出（删账号时尽力调用，失败不影响本地删除）。 */
  logout(session: string, options?: AccountCallOptions): Promise<void>;
}
/** 一条账号记录（落盘的那份）。 */
interface LoomyAccount {
  /** 用户可改的备注名。 */
  label?: string;
  /** 登录用的手机号。 */
  loginid?: string;
  /** 登录用的密码（明文，`0600` 存的；没有就走「粘贴会话」模式）。 */
  password?: string;
  /** 14 天会话，模型网关的 Bearer。 */
  session?: string;
  /** 上游给的 userid。 */
  userid?: string;
  /** 会话拿到的时间（epoch ms）。 */
  obtainedAt?: number;
  /** 会话到期时刻（epoch ms）。上游不告诉我们，按 14 天推。 */
  expireAt?: number;
  /** 该账号自己的设备标识。 */
  identity: LoomyIdentity;
  /** 用户手动暂停（不参与轮转）。 */
  paused?: boolean;
  /** 用户置顶（轮转优先）。 */
  pinned?: boolean;
  /** 会话被上游否定、且没有密码可自动重登 —— 等用户重新登录。 */
  needsLogin?: boolean;
  /** 首次落库时间。 */
  storedAt?: number;
  /** 最近一次成功登录时间。 */
  lastLoginAt?: number;
  /** 展示顺序里的人工名字是否由上游推断（诊断用）。 */
  source?: 'password' | 'sms' | 'session';
}
/** 卡片上一条账号摘要（**不含任何凭证**）。 */
interface LoomyAccountSummary {
  id: string;
  label?: string;
  /** 打码后的手机号。 */
  loginid?: string;
  userid?: string;
  /** 这个号存了密码吗（存了才能无人值守续期）。 */
  hasPassword: boolean;
  /** 会话还能不能用（没被标成 needsLogin，且没到期）。 */
  usable: boolean;
  /** 需要重新登录（会话被拒/过期且无密码）。 */
  needsLogin: boolean;
  /** 会话到期时刻（epoch ms）与剩余天数。 */
  sessionExpiresAt?: number;
  sessionDaysLeft?: number;
  /** 设备标识（只看得到 devid，够区分账号就行）。 */
  devid: string;
  paused: boolean;
  pinned: boolean;
  storedAt?: number;
  lastLoginAt?: number;
  source?: 'password' | 'sms' | 'session';
}
/** 解析出来的、够发一次请求的东西。 */
interface ResolvedLoomyAccount {
  id: string;
  account: LoomyAccount;
  session: string;
}
/** 多账号文档路径。 */
declare function loomyAccountsPath(home?: string): string;
/** 用量台账路径。 */
declare function loomyUsagePath(home?: string): string;
/** 生成一条账号摘要。 */
declare function summarizeAccount(id: string, account: LoomyAccount, now?: number): LoomyAccountSummary;
interface LoomyAccountStoreOptions {
  /** 注入账号服务（测试用假实现）。 */
  service?: AccountService;
  /** 设备标识模式。 */
  identityMode?: IdentityMode;
  log?: (message: string) => void;
  now?: () => number;
}
/**
 * 多账号文档。
 *
 * 文档只管「存了什么」，能不能接活由池（`account-pool.ts`）决定；会话解析在这一层，
 * 因为单飞必须按账号做，而池不该碰凭证。
 */
declare class LoomyAccountStore {
  private readonly path;
  private readonly service;
  private readonly identityMode;
  private readonly log;
  private readonly now;
  private document;
  private loading;
  private readonly slots;
  constructor(path: string, options?: LoomyAccountStoreOptions);
  /** 当前磁盘路径（部署/诊断用）。 */
  get documentPath(): string;
  /** 账号服务客户端（卡片「发送验证码」也要用）。 */
  get accountService(): AccountService;
  private ensureLoaded;
  private load;
  private get doc();
  private flush;
  private slot;
  /** 账号摘要列表（按文档顺序）。 */
  list(): Promise<LoomyAccountSummary[]>;
  /** 账号 id 列表（文档顺序）。 */
  ids(): Promise<string[]>;
  /** 能参与轮转的账号 id（排除暂停与待登录）。 */
  dispatchIds(): Promise<string[]>;
  /** 某个账号的记录副本。 */
  account(id: string): Promise<LoomyAccount | undefined>;
  /** 有没有任何账号。 */
  hasAny(): Promise<boolean>;
  /** 写入/更新一个账号，返回账号 id。 */
  upsert(account: LoomyAccount, id?: string): Promise<string>;
  /**
   * 用手机号+密码登录并落库。
   *
   * 手机号就是自然键（同一个号重新登录不该多出一条记录）；但如果这个号已经有一条
   * `userid` 不同的记录，就按 `userid` 合并 —— 换个手机号登录同一个账号也不会重复。
   */
  signInWithPassword(options: {
    loginid: string;
    password: string;
    label?: string;
    id?: string;
  }): Promise<{
    id: string;
    account: LoomyAccount;
  }>;
  /** 用短信验证码登录并落库（没设密码的账号只能这样拿一次会话）。 */
  signInWithSms(options: {
    loginid: string;
    code: string;
    msgid: string;
    label?: string;
    id?: string;
  }): Promise<{
    id: string;
    account: LoomyAccount;
  }>;
  /** 粘贴一个已有会话（没有密码，到期只能人工再来一次）。 */
  addSession(options: {
    session: string;
    label?: string;
    loginid?: string;
    userid?: string;
    expireAt?: number;
    id?: string;
  }): Promise<string>;
  /** 按手机号找账号 id。 */
  findByPhone(phone: string): Promise<string | undefined>;
  /** 补/改密码（粘贴会话的账号后来补了密码，就能自动续期了）。 */
  setPassword(id: string, password: string): Promise<boolean>;
  /** 删除一个账号。 */
  remove(id: string): Promise<void>;
  /** 清空所有账号。 */
  clear(): Promise<void>;
  /** 暂停/恢复。 */
  setPaused(id: string, paused: boolean): Promise<boolean>;
  /** 置顶/取消置顶。 */
  setPinned(id: string, pinned: boolean): Promise<boolean>;
  /** 改备注名。 */
  setLabel(id: string, label: string): Promise<boolean>;
  private patch;
  /**
   * 解析一个账号，拿到可直接用的会话（必要时静默重登）。
   *
   * @returns 会话；账号不存在、暂停或确实需要人工登录时 undefined。
   */
  resolve(id: string): Promise<ResolvedLoomyAccount | undefined>;
  /** 强制重登一个账号（卡片「重新登录」按钮）。 */
  forceRelogin(id: string): Promise<boolean>;
  /** 上游明确否定了这个会话：有密码就等着自动重登，没密码就标成待登录。 */
  markRejected(id: string, reason: string): Promise<void>;
  /** 从磁盘重读（另一个进程/用户手工改了文档时）。 */
  reloadFromDisk(): Promise<boolean>;
  /**
   * 保活：把「会话快到期」的账号提前续掉。
   *
   * 会话是 14 天，用户可能一周不开 DSH —— 不保活的话下次开就要等一次登录。
   * 这一轮只续有密码的账号；没密码的账号到期只能人工再来，所以这里把它的剩余天数
   * 报出去让卡片提醒。
   */
  keepAlive(): Promise<{
    checked: number;
    refreshed: number;
    needsLogin: string[];
  }>;
}
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
/** 一次点数查询的结果。 */
interface PointsSnapshot {
  /** 永久点数。 */
  balance?: number;
  /** 每日赠送余额。 */
  dailyBalance?: number;
  /** 可用总额（`balance + dailyBalance`）。 */
  available?: number;
}
/** 解析 `/points/records` 响应：`data.*` 或顶层同名字段都接受。 */
declare function parsePoints(raw: unknown): PointsSnapshot;
/** 一个账号的额度状态。 */
interface AccountPoints {
  /** 最近一次成功查到的点数。 */
  snapshot?: PointsSnapshot;
  /** 何时查到的（epoch ms）。 */
  checkedAt?: number;
  /** 查询失败的原因（保留上一次数值，不清空）。 */
  error?: string;
  /** 被上游判过「点数不足」；窗口/时间过了自动作废（不编造重置时刻）。 */
  exhaustedAt?: number;
  /** 被判额度用尽时的原文。 */
  exhaustedReason?: string;
}
/** 点数缓存 + 「额度用尽」标记。 */
declare class LoomyPointsTracker {
  private readonly accounts;
  /** 记一次成功的查询。 */
  noteOk(id: string, snapshot: PointsSnapshot, at?: number): void;
  /** 记一次查询失败（保留上一次数值）。 */
  noteError(id: string, message: string): void;
  /** 记一次「上游说点数不足」。 */
  noteExhausted(id: string, reason: string, at?: number): void;
  /** 上游接受了一次请求：说明这个号现在有额度。 */
  noteServed(id: string): void;
  state(id: string): AccountPoints | undefined;
  /** 这个号现在还能接活吗（没被标额度用尽）。 */
  usable(id: string): boolean;
  /**
   * 额度感知选号用的权值。
   *
   * 没查到过余额的账号给 `undefined`（让池用「最久未用」兜底）；查到 0 的账号也参与
   * 轮转（余额为 0 不等于请求一定失败：每日赠送可能还没刷新进来）。
   */
  available(id: string): number | undefined;
  /** 快照（给状态文档/诊断）。 */
  snapshot(): Record<string, AccountPoints>;
  /** 清掉已删除账号的缓存。 */
  prune(ids: readonly string[]): void;
  clear(): void;
}
/** 上游的「没点数了」长什么样（402 之外，也可能是 403 + 文案）。 */
declare function looksLikeQuotaExhausted(status: number, message: string): boolean;
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
/** 累计计数。 */
interface UsageTotals {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  points: number;
}
/** 一条最近请求记录（不含任何内容）。 */
interface UsageEvent {
  at: number;
  account: string;
  model: string;
  ok: boolean;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  points?: number;
}
/** 台账快照，给卡片/路由用。 */
interface UsageSnapshot {
  /** 统计口径说明（卡片直接展示，避免误读成账号总额度）。 */
  scope: 'local';
  day: string;
  totals: UsageTotals;
  today: UsageTotals;
  byAccount: Record<string, UsageTotals>;
  byModel: Record<string, UsageTotals>;
  recent: readonly UsageEvent[];
}
declare class LoomyUsageTracker {
  private readonly path;
  private document;
  private loaded;
  private flushTimer;
  constructor(options: {
    path: string;
  });
  /** 读盘。失败/文件缺失都不影响插件启动。 */
  load(): Promise<void>;
  /** 记一次请求。 */
  record(event: Omit<UsageEvent, 'at'> & {
    at?: number;
  }): void;
  /** 立刻落盘（插件停用时调）。 */
  flush(): Promise<void>;
  /** 当前快照。 */
  snapshot(): UsageSnapshot;
  private scheduleFlush;
  /** 跨天把 `today` 归零（`totals` 保留）。 */
  private rollDay;
}
interface LoomyShimOptions {
  store: LoomyAccountStore;
  pool: LoomyAccountPool;
  catalog: LoomyCatalog;
  usage: LoomyUsageTracker;
  /** 点数缓存：「额度用尽」标记与余额读数。 */
  points: LoomyPointsTracker;
  /** 用户勾选的模型（模式 + id；缺省全给）。 */
  selection?: () => Selection;
  logger?: {
    debug: (message: string) => void;
    warn: (message: string, ...rest: unknown[]) => void;
  };
}
/** shim 对外句柄。 */
interface LoomyShim {
  baseUrl(): string;
  token(): string;
  ready: Promise<void>;
  close(): Promise<void>;
  stats(): ShimStats;
}
/** 诊断快照。 */
interface ShimStats {
  port: number;
  lastAccount?: string;
  lastModel?: string;
  lastError?: string;
  lastStatus?: number;
  lastLatencyMs?: number;
}
declare function createLoomyShim(options: LoomyShimOptions): LoomyShim;
/** 这个 bundle 拥有的 provider 路由。与 `cordis.patch.yml` 保持一致。 */
declare const LOOMY_PROVIDER = "loomy";
interface LoomyAdapterOptions {
  shim: LoomyShim;
  catalog: LoomyCatalog;
  /** 用户勾选的模型（模式 + id）；缺省全给。 */
  selection?: () => Selection;
  resolveAttachments?: () => AttachmentStore | undefined;
}
interface LoomyAdapter {
  adapter: PiAiAdapter;
  invalidate: () => void;
}
declare function createLoomyAdapter(options: LoomyAdapterOptions): LoomyAdapter;
/** 一次目录抓取的结果。 */
interface CatalogFetch {
  models: readonly LoomyModelInfo[];
}
/** 解析整个 `/models` 响应。 */
declare function parseModelsPayload(raw: unknown): CatalogFetch;
/** 拉一个账号的模型目录。 */
declare function fetchModels(session: string, options?: {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CatalogFetch>;
/** 一次跨账号发现的完整结果。 */
interface DiscoveryOutcome {
  models: readonly LoomyModelInfo[];
  /** 至少一个账号能给出目录。 */
  anySucceeded: boolean;
  accounts: {
    id: string;
    models: number;
    errors: string[];
  }[];
}
/** 逐号发现并合并。 */
declare function discoverModels(store: LoomyAccountStore, signal?: AbortSignal): Promise<DiscoveryOutcome>;
/** 拉一次目录并写进 `catalog`；失败时保留旧目录（上游抖动不该清空模型选择器）。 */
declare function refreshCatalog(store: LoomyAccountStore, catalog: LoomyCatalog, signal?: AbortSignal): Promise<DiscoveryOutcome>;
interface QueueSnapshot {
  /** 正在上游跑的数量。 */
  active: number;
  /** 在本地排队的数量。 */
  queued: number;
  /** 上限（诊断用）。 */
  maxConcurrent: number;
  maxQueue: number;
}
declare class LoomyQueueGate {
  private active;
  private readonly waiters;
  private readonly maxConcurrent;
  private readonly maxQueue;
  private readonly cooldownMs;
  private disposed;
  constructor(options?: {
    maxConcurrent?: number;
    maxQueue?: number;
    cooldownMs?: number;
  });
  /**
   * 申请一个生成位。
   *
   * @returns `true` = 拿到了，用完必须 `release()`；`false` = 队列已满（调用方回 429）。
   */
  acquire(signal?: AbortSignal): Promise<boolean>;
  /** 释放一个生成位，并让队首入场。 */
  release(): void;
  /** 队列里还有几个在等。 */
  queued(): number;
  snapshot(): QueueSnapshot;
  /** 撤掉所有等待者（插件停用）。 */
  dispose(): void;
  /** 有空位就把队首放进来（排队过的请求先冷却一小会儿）。 */
  private pump;
}
interface SignInput {
  method: string;
  /** 未转义的路径，例如 `/login/account/byPwd`。 */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: string;
  contentType?: string;
  /** HTTP 日期串，形如 `Sat, 26 Sep 2026 12:00:00 GMT`。 */
  date: string;
  nonce: string;
  customHeaders?: Record<string, string>;
}
/** 待签名的九行文本。导出给测试逐行比对。 */
declare function stringToSign(input: SignInput): string;
/** HMAC-SHA1 签名（base64）。 */
declare function sign(secret: string, input: SignInput): string;
interface SignedHeadersOptions {
  accessKeyId: string;
  accessKeySecret: string;
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: string;
  contentType?: string;
  customHeaders?: Record<string, string>;
  /** 可注入的时钟/随机数，便于测试。 */
  now?: Date;
  nonce?: string;
}
/**
 * 一次账号服务请求的完整头集合。
 *
 * `Content-MD5` 只在有 body 时出现 —— 但签名里的那一行**永远**存在（空串）。
 */
declare function buildAccountHeaders(options: SignedHeadersOptions): Record<string, string>;
/** 按 PKCS#1 v1.5 加密明文（密码），返回 base64 密文。 */
declare function rsaEncrypt(derBase64: string, plaintext: string): string;
/** 构建时由 tsdown 注入的包版本；直接跑源码（测试/调试）时退化成 dev 标记。 */
declare const LOOMY_VERSION: string;
/** 稳定的 Cordis 插件名（与 `cordis.patch.yml` 的 id 对齐）。 */
declare const name = "llm-loomy";
/** provider 注册前必须先有 `llm` 服务。 */
declare const inject: string[];
/** 拥有配置卡片的 settings 命名空间。 */
declare const LOOMY_SETTINGS_NS: SettingsNamespace;
/** 插件配置。 */
interface Config {
  /** 模型选择器里允许出现的模型 id（`custom` 模式时生效；空 = 全部）。 */
  enabledModels?: string[];
  /** 模型勾选模式：`all` 全部 / `none` 一个都不给 / `custom` 只给勾选的。 */
  modelSelectionMode?: SelectionMode;
  /** 对话输入框下方的 `Provider Loomy · 模型 · 今日点数` 那一行。 */
  showDock?: boolean;
  /** 侧边栏图标列里的 Loomy 入口。缺省关：图标列是全宿主共用资源。 */
  showSidebarPanel?: boolean;
  /** 设置左侧导航里的 Loomy 入口。缺省开。 */
  showSettingsEntry?: boolean;
  /** 同时打到上游的生成数。 */
  maxConcurrent?: number;
  /** 本地排队上限，超出直接 429。 */
  maxQueue?: number;
  /** 选号策略。 */
  strategy?: PoolStrategy;
  /** 会话快到期时自动用存着的密码重登。 */
  autoRenew?: boolean;
}
declare const Config: z<Config>;
/** 点数说明（卡片直接展示，别让用户以为这是本机估算）。 */
declare const POINTS_NOTE: string;
declare function apply(ctx: Context, rawConfig: Config): void;
export { type AccountPoints, type AccountRuntime, AccountService, Config, type DiscoveryOutcome, LOOMY_PROVIDER, LOOMY_SETTINGS_NS, LOOMY_VERSION, LoginError, type LoomyAccount, LoomyAccountPool, LoomyAccountStore, type LoomyAccountSummary, type LoomyAdapter, LoomyCatalog, type LoomyIdentity, type LoomyModelInfo, LoomyPointsTracker, LoomyQueueGate, type LoomyShim, LoomyUsageTracker, POINTS_NOTE, type PointsSnapshot, type PoolStrategy, type Selection, type SelectionMode, type ShimStats, type UsageSnapshot, apply, buildAccountHeaders, createLoomyAdapter, createLoomyShim, discoverModels, fetchModels, filterEnabledModels, inject, invertSelection, isSelectionMode, looksLikeQuotaExhausted, loomyAccountsPath, loomyUsagePath, mergeModelLists, name, newIdentity, normalizeSelection, parseModelsPayload, parsePoints, refreshCatalog, resolveSelection, rsaEncrypt, sign, stringToSign, summarizeAccount };