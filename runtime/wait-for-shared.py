#!/usr/bin/env python3
import sys
import time
from pathlib import Path
socket=Path(sys.argv[1])
for _ in range(100):
    target=str(socket.resolve())
    for line in Path('/proc/net/unix').read_text().splitlines()[1:]:
        p=line.split(maxsplit=7)
        if len(p)==8 and p[7]==target and int(p[3],16)&0x10000:
            sys.exit(0)
    time.sleep(0.1)
print('Shared app-server did not become ready. Check: journalctl --user -u codex-shared.service',file=sys.stderr)
sys.exit(69)
