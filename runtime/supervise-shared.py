#!/usr/bin/env python3
"""Keep a shared server available; preserve an already-running external server."""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

sock = Path(os.environ['CODEX_UNIX_SOCKET'])
binary = os.environ['CODEX_SHARED_BINARY']
sock.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(sock.parent, 0o700)
lock = open(sock.parent/'supervisor.lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
running = True
child = None
def stop(*_):
    global running
    running = False
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
def reachable():
    target = str(sock.resolve())
    # Check the Linux listener table without creating incomplete WS handshakes.
    for line in Path('/proc/net/unix').read_text().splitlines()[1:]:
        parts = line.split(maxsplit=7)
        if len(parts)==8 and parts[7]==target and int(parts[3],16)&0x10000:
            return True
    return False

try:
    if reachable():
        print('Using the existing shared app-server; its sessions will continue.', flush=True)
        while running and reachable():
            time.sleep(5)
    if running:
        # Let Codex handle its own stale socket alias. Never unlink a live alias.
        print('Starting the pinned shared app-server.', flush=True)
        child = subprocess.Popen([binary,'app-server','--listen','unix://'+str(sock)])
        while running and child.poll() is None:
            time.sleep(1)
finally:
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
if child is not None and child.returncode and running:
    sys.exit(child.returncode)
