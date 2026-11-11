# Sharing the studio on your network (Step 9.5)

By default the studio only listens on this computer (`127.0.0.1`) and has no sign-in. Nothing in this
page changes that default.

When you share it on your network with `UAIS_HOST` (for example `UAIS_HOST=0.0.0.0 ./linux.sh`, or
`set UAIS_HOST=0.0.0.0` before `windows.bat`), **every other device must sign in**. Sign-in can't be
turned off while the server is reachable from the network.

## What you see

* **On the computer running the studio:** nothing changes. Open `http://localhost:1420` as usual.
  Requests from this computer to a loopback address (`localhost`, `127.0.0.1`) don't need to sign in.
* **On another device:** opening `http://<computer-address>:1420` shows a sign-in page. Paste the
  access token once; the browser then stays signed in for 12 hours. The studio's interface is
  unchanged.

The startup banner shows `Sign-in : required …` and the path of the token file. It never shows the
token itself.

## The access token

The first network-shared start creates a random token (256 bits) in `app/config/lan-access-token`. The
file is readable only by your user account: mode `0600` on macOS and Linux, and on Windows an access
list with your account only (no inherited entries; Windows also keeps `SYSTEM` and, for administrator
accounts, `Administrators`, which can read every file anyway). Permissions are re-applied on every
network-shared start. FAT/exFAT drives (common for USB sticks) can't store permissions; the studio then
warns at startup that anyone who can read the drive can sign in. The file is stored with the portable
copy, so a USB drive keeps the same token.

`app/config/` is excluded from Git, and none of the CI workflows upload it. The studio only serves files
from `app/dist/`, so the token file can't be fetched over HTTP.

Manage it with the bundled Node.js (or any Node.js 18+), from the studio folder:

| Command | What it does |
|---|---|
| `node scripts/server/lan-auth.cjs show` | Prints the token, so you can copy it |
| `node scripts/server/lan-auth.cjs rotate` | Creates a new token. **Every signed-in device is signed out at once**, and the old token stops working |
| `node scripts/server/lan-auth.cjs revoke` | Deletes the token. **All network access is refused** until you run `rotate`; a restart also creates a new one |
| `node scripts/server/lan-auth.cjs status` | Says whether a token exists, without printing it |

The running studio notices `rotate` and `revoke` immediately; no restart is needed.

**Treat the token like a password.** Anyone who has it can use the studio, including its file, model
and settings operations. If it may have leaked, run `rotate`.

## Scripts and API clients

Send the token in a header: `Authorization: Bearer <token>`. Tokens are **never** accepted in a URL
(`?token=` is ignored), because URLs end up in browser history, proxy logs and `Referer` headers.

Endpoints (additive; the existing API is unchanged):

| Route | Purpose |
|---|---|
| `GET /api/auth/status` | `{ ok, required, authenticated }`. Available without signing in; reveals nothing else |
| `POST /api/auth/login` | Body `{"token": "…"}` (JSON) or a form field `token`. Sets the session cookie |
| `POST /api/auth/logout` | Ends this browser's session |

Without a valid credential, API routes answer `401` with `{"ok": false, "error": "Sign-in required.", "code": "auth_required"}`.

## How it is protected

* **Everything is behind sign-in**: model management, file operations, settings, chat, image, speech and
  voice control, downloads, diagnostics, the image engine's `/v1/*` and `/sdapi/*` routes, and the
  interface's own files. Only the sign-in page and `/api/auth/*` are open.
* **Browser sessions** use a random session id in a cookie marked `HttpOnly` (page scripts can't read
  it) and `SameSite=Strict` (other websites can't send it). The token never reaches the browser after
  sign-in, and nothing is embedded in the interface's files.
* **Cross-site requests (CSRF)**: requests from other websites (a foreign `Origin`) are refused before
  sign-in is even checked, even when they carry a valid session cookie. The cookie is also
  `SameSite=Strict`, so browsers don't attach it to requests started by other sites.
* **Session fixation**: session ids are created only by the server, and every sign-in issues a new
  one. A cookie value planted beforehand never becomes valid.
* **The "this computer" exemption** requires all of:
  * a loopback connection;
  * a loopback `Host` name, so a DNS-rebinding page on this computer still has to sign in;
  * no proxy headers (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`), so most reverse proxies don't
    turn network traffic into "local" traffic.
* **Rate limiting**: after 10 failed attempts from one address (one /64 for IPv6) within 15 minutes,
  that address is refused (`429` with `Retry-After`) until the window ends, even with the right token.
  The address is the connection's own; forwarding headers are ignored, so they can't reset the count.
* **No disclosure**: failures say only that sign-in is required or failed. The token and session ids
  are never logged, and the studio doesn't forward its cookie or `Authorization` header to its local
  engines.
* **Request validation**: JSON routes require `Content-Type: application/json` (S-9). A request with
  any other declared type, or an untyped body, gets `415`. A `POST` with no body (for example
  `/api/llm/stop`) still works.

## Settings

| Variable | Effect |
|---|---|
| `UAIS_HOST` | Address to listen on. Anything other than loopback turns sign-in on |
| `UAIS_AUTH=on` | Also require sign-in for requests from this computer. Use it when a reverse proxy on this computer forwards network traffic to the studio (otherwise the proxy's requests would look local) |
| `UAIS_AUTH=auto` | Default: sign-in only when the server is reachable from the network |

Any other `UAIS_AUTH` value is treated as `auto` with a warning. There is no "off".

## Limitations

* **Never expose the studio directly to the internet** (port forwarding, a public cloud address). Sign-in
  is designed for a trusted home or office network. Internet exposure needs its own reviewed deployment
  (HTTPS, an authenticating proxy, firewalling), which USAP doesn't provide.
* **A reverse proxy on this computer must use `UAIS_AUTH=on`.** Some proxies (for example a plain nginx
  `proxy_pass`) send no proxy headers and rewrite `Host` to `127.0.0.1`. Their requests then look exactly
  like local ones. The same applies in the default local-only mode, which has no sign-in at all.
* **The connection is plain HTTP.** On the network, the token (once, at sign-in) and the session cookie
  can be observed by anyone who can watch your traffic, such as on public or untrusted Wi-Fi. Share the
  studio only on a network you trust. On sensitive networks, terminate HTTPS in a reverse proxy (with
  `UAIS_AUTH=on`). Built-in HTTPS is not provided; deployment guidance is tracked in
  [#26](https://github.com/dlroqa/usap/issues/26).
* **One shared token, no user accounts.** Everyone who signs in has the same access, and there's no
  per-device revocation. `rotate` signs everyone out. Optional multi-user accounts:
  [#28](https://github.com/dlroqa/usap/issues/28).
* **A signed-in device can see where linked models are stored.** Status and diagnostics routes shorten
  host paths for every client (#52), but model lists and the "Link a file" response include the full
  location (`linkedFrom`) of each model linked in place, because Model Manager shows it. That can reveal
  folder names and your user name. Values under `settings` in status responses are not shortened; today
  they hold only file names and model IDs. Opaque identifiers are tracked in
  [#57](https://github.com/dlroqa/usap/issues/57).
* **Sessions are kept in memory.** Restarting the studio signs every device out.
* **A device whose session expires** sees errors in the open interface until the page is reloaded,
  which then shows the sign-in page. The interface itself is unchanged and has no sign-out button;
  use `rotate`, or wait for the session to expire. Tracked in [#27](https://github.com/dlroqa/usap/issues/27).
* Anyone with an account on the computer running the studio can read the token file (Windows), or use
  the studio from that computer without signing in. That is the same as the default local mode.
