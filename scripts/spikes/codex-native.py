"""Exercise the installed Codex sandbox without asking a model to attempt a write."""
import json
import os
import pathlib
import select
import signal
import subprocess
import tempfile
import time

with tempfile.TemporaryDirectory(prefix="jevellan-native-controls-") as directory:
    root = pathlib.Path(directory)
    (root / "home").mkdir()
    (root / "project").mkdir()
    env = {key: value for key, value in os.environ.items() if key in ["PATH", "HOME", "USER", "LANG", "TERM", "SHELL", "TMPDIR"]}
    env["CODEX_HOME"] = str(root / "home")
    process = subprocess.Popen(["codex", "app-server"], env=env, cwd=root / "project", stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    counter = 0
    pending = b""

    def rpc(method, params):
        global counter, pending
        counter += 1
        process.stdin.write((json.dumps({"id": counter, "method": method, "params": params}) + "\n").encode())
        process.stdin.flush()
        until = time.monotonic() + 20
        while time.monotonic() < until:
            if b"\n" not in pending:
                readable, _, _ = select.select([process.stdout], [], [], 1)
                if not readable:
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError("Codex app-server exited")
                pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                message = json.loads(line)
                if message.get("id") == counter:
                    if "error" in message:
                        raise RuntimeError("Protocol request rejected: " + str(message["error"].get("code")))
                    return message["result"]
        raise TimeoutError(method)

    try:
        rpc("initialize", {"clientInfo": {"name": "jevellan_spike", "version": "0.1.0"}})
        process.stdin.write(b'{"method":"initialized","params":{}}\n')
        process.stdin.flush()
        result = rpc("command/exec", {"command": ["/bin/sh", "-c", "printf test > blocked.txt"], "cwd": str(root / "project"), "timeoutMs": 10000, "sandboxPolicy": {"type": "readOnly", "networkAccess": False}})
        evidence = {"schema": "codex-native-sandbox-v1", "evidence": "installed-runtime-no-model", "exitCode": result["exitCode"], "fileCreated": (root / "project/blocked.txt").exists(), "denialReported": any(word in result.get("stderr", "").lower() for word in ["denied", "not permitted", "read-only"])}
        print(json.dumps(evidence, indent=2))
        assert evidence["exitCode"] != 0 and not evidence["fileCreated"] and evidence["denialReported"]
    finally:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
