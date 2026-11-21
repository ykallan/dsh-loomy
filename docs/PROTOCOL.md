# Loomy protocol notes

What this plugin relies on, and where each fact came from. Everything here was read from two
working implementations — [`Patrick130306/loomy2api`](https://github.com/Patrick130306/loomy2api)
(server-side password login + the model gateway) and
[`wangliangdong/loomy2api`](https://github.com/wangliangdong/loomy2api) (web-cookie login) —
and cross-checked against the official desktop client's behaviour as recorded in their docs.

Keep this file in sync with `src/config.ts`: that module is the single source of the literals,
this file explains *why* they are what they are.

---

## 1. Two upstreams, two auth schemes

| Purpose | Host | Auth |
|---|---|---|
| Account service (login, session, userinfo) | `https://account.xfinfr.com` | HMAC-SHA1 signature with client-shipped keys |
| Model gateway (OpenAI-compatible) | `https://loomyad.xunfei.cn/api/v1` | the login session, as `Bearer` |
| Web console (browser only, **not** used here) | `https://loomy.xunfei.cn/web` | cookie `loomy_web_session` |

The desktop client is an Electron app whose main-process sources ship unencrypted and whose
provider is configured with `useSessionAuth: true` — it stores no API key and simply sends the
login session as the bearer token. That single fact is what makes a gateway without the client
possible: obtain a session, and the gateway accepts you.

The web-console API (`loomy.xunfei.cn/web/api/chat/completions`) is a **different** upstream
that takes a single `content` string with no role array, no tools and no sampling parameters.
This plugin deliberately uses the **model gateway** instead: it is OpenAI-compatible, so tools,
streaming and `reasoning_effort` survive.

## 2. Account-service endpoints

All `POST`, all with the same `{"base": {...}, "param": {...}}` envelope:

| Path | Purpose |
|---|---|
| `/login/account/getPuKey` | RSA public key (`pukey`, base64 DER) + `rcode` (server nonce) |
| `/login/account/byPwd` | `{loginid, password: base64(RSA(password)), rcode, type: 1, expire: 1209600}` |
| `/login/phone/sendMsgCode` | `{ccode: "86", phone, expire: 300}` → `{msgid}` |
| `/login/phone/checkCode` | `{ccode, phone, mcode, msgid, expire}` → session |
| `/login/account/logout` | `{session}` |
| `/userinfo/query/baseInfo` | `{session}` → profile |

`rcode` is a **server-issued nonce, not a captcha** — which is exactly why password login is
fully scriptable.

### The envelope

```json
{"base": {"appid": "GM3LOOMY", "modelid": "Web", "version": "1.0.0",
          "devid": "web", "ua": "Loomy|Desktop|Electron|macOS", "traceid": "<32 hex>"}}
```

`traceid` is regenerated on every request by the real client; `devid` is the constant `web`
there. This plugin gives each account its own `devid` (`web-<16 hex>`) by default
(`identity_mode = per_account`), which keeps accounts distinguishable in that field. It does
**not** change the network origin, which is what most risk control actually keys on.

## 3. Account-service signing

`stringToSign` is **nine lines**; the last two are empty strings when no `x-*` headers are sent,
but they must not be omitted:

```
METHOD                                   # uppercase
ESCAPED_PATH                             # per-segment RFC3986 (encodeURIComponent + !'()*)
ESCAPED_QUERY                            # "" when there is no query
Content-MD5                              # base64(md5(raw body)), "" when there is no body
Content-Type                             # application/json
Date                                     # e.g. Sat, 26 Sep 2026 12:00:00 GMT
Nonce                                    # a UUID
SignedHeaders                            # sorted lowercase x-* names joined by ";"
CanonicalizedHeaders                     # sorted "k:v\n" lines, trailing newline stripped
```

```
signature     = base64(HMAC-SHA1(accessKeySecret, stringToSign))
Authorization = "account <accessKeyId>:<signature>"
```

The access-key pair is a client-side constant present in every installation (obfuscated with a
passphrase shipped next to it — obfuscation, not secrecy). Override it with `LOOMY_AK_ID` /
`LOOMY_AK_SECRET` if a future client ships different keys.

Error fingerprints:

| Response | Meaning |
|---|---|
| `HMAC signature does not match` | the key is known but the canonical string is wrong (usually a missing line) |
| `HMAC signature cannot be verified` | this access key is not recognised (wrong environment/key) |

## 4. Sessions

- **14 days**, requested explicitly at login (`expire: 1209600`).
- **No refresh token.** When it expires you must log in again — which is why an unattended
  setup needs the password stored.
- The session is the model gateway's `Bearer` token verbatim.

`SESSION_RENEW_BEFORE_MS` (3 days) and a 6-hour keep-alive loop mean a stored password keeps a
pool alive indefinitely. An account added by pasting a session (no password) simply lapses
after 14 days and is marked *needs sign-in*.

## 5. Model gateway

Headers on **every** model request:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <session>` |
| `token` | `<session>` (both spellings are accepted; the client sends both) |
| `traceparent` | `00-<32 hex>-<16 hex>-01` — **without it the upstream hangs until timeout** |
| `loomy-version` | client version, presence-checked only |
| `Content-Type` | `application/json` |
| `X-Loomy-Request-Purpose` | `chat.message` (17 values exist upstream; it feeds points bookkeeping) |

Endpoints used here:

| Endpoint | Notes |
|---|---|
| `GET /models` | `{object:"list", data:[{id, name, context_length, max_output_tokens, capabilities{reasoning,vision,function_calling,streaming}, reasoning_efforts}]}` |
| `POST /chat/completions` | OpenAI-compatible; `stream: true` on the **same** path; the final SSE chunk carries `usage`, including `points_consumed` |
| `GET /points/records?record_type=all&page_no=1&page_size=1` | `data.{balance, dailyBalance, availableBalance, list[]}` |

Not used, but present upstream: `/images/generations`, `/embeddings`, `/search/tencent`,
`/team-points/balance`, `/points/first-login`, `/points/activation`.

### Unknown model ids are silently rewritten

The upstream **does not 404 an unknown model**: it answers 200 with its default model
(`deepseek-v4-flash-0731`). This plugin therefore validates every requested id against the
discovered catalog and answers `400 unknown model` instead of letting you believe you are
talking to something else. While the catalog is empty (not signed in yet) requests pass
through unchanged.

### Reasoning

Reasoning models expose `reasoning_content` alongside `content`. The client suppresses
reasoning on short prompts with a combination of `enable_thinking: false`,
`chat_template_kwargs.enable_thinking` and a `/no_think` prefix; this plugin forwards whatever
the caller sends and does not re-shape the body — the gateway is OpenAI-compatible, so pi-ai
already speaks it.

## 6. Quota semantics

`availableBalance = balance (permanent) + dailyBalance (free daily grant, consumed first)`.
Model multipliers (`x0.1` … `x12.0`, shown in the model `name`) scale how many points a request
costs; `spark-x` at `x0.1` is the cheapest.

What is observable:

| Observable | Source | Used for |
|---|---|---|
| remaining points | `GET /points/records` | the card, and `balance` account selection |
| points this turn | `usage.points_consumed` | the local usage ledger |
| "out of points" | `402`, or `insufficient` / `点数不足` wording | per-account cooldown + failover |

The **daily grant's reset moment is not documented**, so the card shows the number and no
countdown. Never invent a reset clock.

## 7. Error semantics worth preserving

| Upstream signal | Meaning | Handling |
|---|---|---|
| `401` / `403` | the session is dead | renew with the stored password; without one, mark *needs sign-in* |
| `402` / points wording | the account is out of points | cool it down for 10 minutes, retry on another account, and surface `402` (not a vague `429`) |
| `429` / rate-limit wording | throttled | cool down, retry on another account |
| `5xx` / `408` | upstream hiccup | retry on another account |
| `400` + length wording | context overflow | report it as-is, do not retry |
| `200` + first SSE frame `{"error":…}` | error delivered as a stream | peek the first frame and surface it as an error |

`403` can also mean the account was blocked; the classification keeps `needsLogin` so the card
asks for a fresh sign-in instead of retrying forever.
