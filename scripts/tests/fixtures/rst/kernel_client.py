# #151 transport diagnostics (test-only): a client with no Node in it, so only the kernel decides what it sees.
# Args: port mode(idle|sending) wait_ms. Sends the request head and 32 KiB, then either stays idle or keeps sending
# (non-blocking) until wait_ms, never reading; then calls recv() up to 4 times. Prints one JSON object: what send
# reported during the wait (first error and its time) and each recv result: data (bytes, whether it starts with the
# 413 status line), eof, empty (EAGAIN) or the error name. Times: ms since the epoch (same clock as the server).
import errno, json, socket, sys, time
port, mode, wait_ms = int(sys.argv[1]), sys.argv[2], float(sys.argv[3])
now = lambda: int(time.time() * 1000)
name = lambda e: errno.errorcode.get(e.errno, str(e.errno)) if getattr(e, "errno", None) else type(e).__name__
s = socket.create_connection(("127.0.0.1", port))
t0 = now()
s.sendall(b"POST /api/cleanup HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 104857600\r\n\r\n" + b"a" * 32768)
s.setblocking(False)
out = {"t0": t0, "mode": mode, "sendError": None, "sent": 32768, "recv": []}
chunk = b"a" * 16384
end = t0 + wait_ms
while now() < end:
    if mode == "sending" and out["sendError"] is None:
        try:
            out["sent"] += s.send(chunk)
        except BlockingIOError:
            pass
        except OSError as e:
            out["sendError"] = [name(e), now()]
    time.sleep(0.005)
for _ in range(4):
    try:
        d = s.recv(65536)
        if not d:
            out["recv"].append(["eof", now()]); break
        out["recv"].append(["data", now(), len(d), d.startswith(b"HTTP/1.1 413")])
    except BlockingIOError:
        out["recv"].append(["empty", now()]); break
    except OSError as e:
        out["recv"].append(["error", now(), name(e)])
try:
    s.close()
except OSError:
    pass
print(json.dumps(out))
