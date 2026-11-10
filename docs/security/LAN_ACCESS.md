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

The first network-shared start creates a random token (256 bits) in `app/config/lan-access-token`. On
macOS and Linux the file is readable only by your user account. On Windows it inherits the folder's
permissions. It's stored with the portable copy, so a USB drive keeps the same token.

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
* **The existing protections stay**: requests from other websites (a foreign `Origin`) are refused
  before sign-in is even checked. The "this computer" exemption requires both a loopback connection
  and a loopback `Host` name, so a DNS-rebinding page on this computer still has to sign in.
* **Rate limiting**: after 10 failed attempts from one address (one /64 for IPv6) within 15 minutes,
  that address is refused (`429` with `Retry-After`) until the window ends, even with the right token.
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

* **The connection is plain HTTP.** On the network, the token (once, at sign-in) and the session cookie
  can be observed by anyone who can watch your traffic, such as on public or untrusted Wi-Fi. Share the
  studio only on a network you trust, or put it behind an HTTPS reverse proxy (with `UAIS_AUTH=on`).
  Built-in HTTPS is not provided.
* **One shared token, no user accounts.** Everyone who signs in has the same access, and there's no
  per-device revocation. `rotate` signs everyone out.
* **Sessions are kept in memory.** Restarting the studio signs every device out.
* **A device whose session expires** sees errors in the open interface until the page is reloaded,
  which then shows the sign-in page. The interface itself is unchanged and has no sign-out button;
  use `rotate`, or wait for the session to expire.
* Anyone with an account on the computer running the studio can read the token file (Windows), or use
  the studio from that computer without signing in. That is the same as the default local mode.
