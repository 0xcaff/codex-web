#!/usr/bin/env python3
"""Exercise a real first-install snapshot without changing any user services."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

package = Path(__file__).resolve().parents[2]

with tempfile.TemporaryDirectory(prefix='codex-web-install-') as temporary:
    root = Path(temporary)
    home = root/'Home with spaces % test'
    home.mkdir(mode=0o700)
    commands = root/'commands'
    commands.mkdir()
    service_log = root/'systemctl.jsonl'
    # All systemctl calls are recorded, never forwarded to the real manager.
    stub = commands/'systemctl'
    stub.write_text('#!'+sys.executable+'\n'
                    'import json, os, sys\n'
                    'with open(os.environ["TEST_SERVICE_LOG"], "a") as log:\n'
                    '    log.write(json.dumps(sys.argv[1:])+"\\n")\n')
    stub.chmod(0o755)
    env = {**os.environ, 'HOME':str(home),
           'PATH':str(commands)+os.pathsep+os.environ['PATH'],
           'TEST_SERVICE_LOG':str(service_log)}
    command = [sys.executable, str(package/'scripts/install-services.py')]
    for option, variable, executable in [('--codex','CODEX_TEST_CODEX','codex'),
                                        ('--node','CODEX_TEST_NODE','node'),
                                        ('--websocat','CODEX_TEST_WEBSOCAT','websocat')]:
        candidate = os.environ.get(variable) or shutil.which(executable)
        if not candidate:
            raise SystemExit(f'{executable} is required for the installer smoke test')
        command += [option,candidate]
    print('Installing into an isolated home; real systemctl is blocked',flush=True)
    first = json.loads(subprocess.check_output(command+['--access','lan','--port','9000','--restart'],env=env,text=True))
    current = home/'.local/share/codex-web/current'
    assert current.is_symlink() and current.resolve()==Path(first['release'])
    assert (current/'bin/codex-web-proxy').stat().st_mode & 0o111
    assert (home/'.local/bin/codex-shared').resolve()==current.resolve()/'bin/codex-shared'
    config = home/'.config/codex-web/server.json'
    assert config.stat().st_mode & 0o777 == 0o600
    assert json.loads(config.read_text())=={'host':'0.0.0.0','port':9000}
    manifest = json.loads((current/'installation.json').read_text())
    assert 'bin/codex' in manifest['files']
    second = json.loads(subprocess.check_output(command,env=env,text=True))
    assert first['release']==second['release']
    assert second['network']==first['network']
    calls = [json.loads(line) for line in service_log.read_text().splitlines()]
    assert ['--user','restart','codex-web.service'] in calls
    assert not any('restart' in call and 'codex-shared.service' in call for call in calls)
    print('PASS: first install, quoted paths, snapshot, CLI entry, saved LAN settings, and repeat install')
