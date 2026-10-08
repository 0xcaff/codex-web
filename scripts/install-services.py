#!/usr/bin/env python3
"""Install a built codex-web package as persistent Linux user services."""
import argparse
import filecmp
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parent.parent

def network_settings(config_path, *, access=None, host=None, port=None):
    """First install is local; subsequent installs retain the saved choice."""
    saved=json.loads(config_path.read_text()) if config_path.exists() else {}
    if not isinstance(saved,dict):
        raise ValueError('Server configuration must be a JSON object')
    selected_host={'local':'127.0.0.1','lan':'0.0.0.0'}.get(access,host)
    selected_host=selected_host if selected_host is not None else saved.get('host','127.0.0.1')
    selected_port=port if port is not None else saved.get('port',8214)
    if not isinstance(selected_host,str) or '%' in selected_host:
        raise ValueError('Host must be an IPv4 or IPv6 address')
    selected_host=str(ipaddress.ip_address(selected_host))
    if type(selected_port) is not int or not 1<=selected_port<=65535:
        raise ValueError('Port must be an integer between 1 and 65535')
    return {'host':selected_host,'port':selected_port}


def install_file(source,target):
    # Reconfiguring the live release must not truncate its running executables.
    if target.is_file() and filecmp.cmp(source,target,shallow=False):
        return
    staged=target.with_name(target.name+'.install-'+str(os.getpid()))
    shutil.copy2(source,staged)
    staged.replace(target)


def executable(value,name):
    candidate=value or shutil.which(name)
    if not candidate: raise ValueError(f'{name} is required; install it or supply --{name}')
    result=Path(candidate).expanduser().resolve()
    if not result.is_file() or not os.access(result,os.X_OK):
        raise ValueError(f'Not executable: {result}')
    return result


def native_codex(entry):
    def native(path):
        with path.open('rb') as handle: return handle.read(4)==b'\x7fELF'
    if native(entry): return entry
    # Official npm launches a native platform package. Locate it relative to
    # the launcher rather than relying on a particular npm/nvm installation.
    for pattern in ['vendor/*/bin/codex','node_modules/@openai/codex-*/vendor/*/bin/codex']:
        for candidate in entry.parent.parent.glob(pattern):
            if candidate.is_file() and native(candidate): return candidate
    raise ValueError('Could not locate native Codex; pass --codex /path/to/vendor/.../bin/codex')


def quote(value):
    text=str(value)
    if '\n' in text or '\r' in text: raise ValueError('Paths cannot contain newlines')
    return json.dumps(text,ensure_ascii=False).replace('%','%%')


def unit_path(value):
    # WorkingDirectory is a single path, not a shell argument list. systemd
    # keeps surrounding quotes literally here, even though ExecStart needs them.
    text=str(value)
    if '\n' in text or '\r' in text:raise ValueError('Paths cannot contain newlines')
    return text.replace('%','%%')


def service_units(current,state,network,python,app_tools=None):
    env_path=f'{current}/bin:{Path.home()}/.local/bin:/usr/local/bin:/usr/bin:/bin'
    shared=f'''[Unit]
Description=Shared local Codex app-server

[Service]
Type=simple
WorkingDirectory={unit_path(Path.home())}
Environment=CODEX_UNIX_SOCKET=%t/codex-shared/app.sock
Environment={quote('CODEX_SHARED_BINARY='+str(current/'bin/codex'))}
Environment={quote('PATH='+env_path)}
ExecStart=:{quote(python)} {quote(current/'bin/supervise-shared.py')}
Restart=on-failure
RestartSec=3
TimeoutStopSec=25
UMask=0077
LogRateLimitIntervalSec=30s
LogRateLimitBurst=200

[Install]
WantedBy=default.target
'''
    web=f'''[Unit]
Description=Codex browser client for the shared local runtime
Wants=codex-shared.service
After=codex-shared.service

[Service]
Type=simple
WorkingDirectory={unit_path(state)}
Environment=CODEX_UNIX_SOCKET=%t/codex-shared/app.sock
Environment=CODEX_SHARED_TOOLS_PIPE_PATH=%t/codex-shared/tools.sock
Environment={quote('CODEX_CLI_PATH='+str(current/'bin/codex-web-proxy'))}
Environment={quote('PATH='+env_path)}
ExecStart=:{quote(current/'bin/node')} {quote(current/'src/server/main.js')} --host {network['host']} --port {network['port']}
Restart=on-failure
RestartSec=3
UMask=0077
LogRateLimitIntervalSec=30s
LogRateLimitBurst=200

[Install]
WantedBy=default.target
'''
    if app_tools is not None:
        web=web.replace('Environment=CODEX_UNIX_SOCKET=',f'Environment={quote("CODEX_SHARED_TOOLS_MCP="+str(app_tools))}\nEnvironment=CODEX_UNIX_SOCKET=',1)
    return {'codex-shared.service':shared,'codex-web.service':web}


def save_unit(target,content):
    if target.exists():
        if target.read_text()==content:return
        digest=hashlib.sha256(target.read_bytes()).hexdigest()[:16]
        backup=target.with_name(target.name+'.before-'+digest)
        if not backup.exists():shutil.copy2(target,backup)
    staged=target.with_name(target.name+'.install-'+str(os.getpid()))
    staged.write_text(content)
    staged.replace(target)


def verify_release_units(release,state,network,python,app_tools=None):
    # A first installation has no current symlink yet. Validate the exact
    # executable paths in the completed snapshot before changing live units.
    with tempfile.TemporaryDirectory(prefix='codex-web-units-') as temporary:
        directory=Path(temporary)
        units=service_units(release,state,network,python,app_tools)
        for name,content in units.items():
            (directory/name).write_text(content)
        subprocess.run(['systemd-analyze','--user','verify',*[str(directory/name) for name in units]],check=True)


def main():
    parser=argparse.ArgumentParser(description='Install persistent Linux Codex/Web services and retain saved network settings.')
    parser.add_argument('package',type=Path,nargs='?',default=ROOT,help='Built package directory (default: this checkout)')
    access=parser.add_mutually_exclusive_group()
    access.add_argument('--access',choices=['local','lan'],help='First install defaults to local; lan listens on 0.0.0.0')
    access.add_argument('--host',help='Custom listening IP address')
    parser.add_argument('--port',type=int,help='First install defaults to 8214')
    parser.add_argument('--codex',help='Codex executable; native binary or official npm launcher')
    parser.add_argument('--node',help='Node executable (22.12 or later)')
    parser.add_argument('--websocat',help='websocat executable')
    parser.add_argument('--app-tools',type=Path,help='Optional official codex-app-tools 0.1.5 server.mjs path')
    parser.add_argument('--restart',action='store_true',help='Start/restart Web after installation; leave shared sessions running')
    parser.add_argument('--dry-run',action='store_true',help='Print settings and service files without changing the system')
    args=parser.parse_args()
    home=Path.home()
    base=home/'.local/share/codex-web'
    current=base/'current'
    state=home/'.local/state/codex-web'
    config=home/'.config/codex-web/server.json'
    source=args.package.expanduser().resolve()
    try:
        if sys.platform!='linux':raise ValueError('Persistent shared services currently require Linux and systemd --user')
        network=network_settings(config,access=args.access,host=args.host,port=args.port)
        codex=native_codex(executable(args.codex,'codex'))
        node=executable(args.node,'node')
        websocat=executable(args.websocat,'websocat')
        node_version=subprocess.check_output([str(node),'--version'],text=True).strip()
        if tuple(map(int,node_version.lstrip('v').split('.')[:2]))<(22,12):
            raise ValueError('Node 22.12 or later is required')
        codex_version=subprocess.check_output([str(codex),'--version'],text=True).strip()
        version=re.search(r'(\d+)\.(\d+)\.(\d+)',codex_version)
        if not version or tuple(map(int,version.groups()))<(0,160,1):
            raise ValueError('Shared sessions require Codex 0.160.1 or later; select a newer executable with --codex')
        if not (source/'src/server/main.js').is_file() or not (source/'scratch/asar/webview/index.html').is_file():
            raise ValueError('Build the package first: npm ci && npm run build')
        if not (source/'node_modules').is_dir():
            raise ValueError('Install dependencies in a source checkout with npm ci before installing shared services')
        app_tools=args.app_tools.expanduser().resolve() if args.app_tools else None
        if app_tools is not None and not app_tools.is_file():raise ValueError(f'Desktop MCP source not found: {app_tools}')
        units=service_units(current,state,network,Path(sys.executable),app_tools)
        if args.dry_run:
            print(json.dumps({'network':network,'config':str(config),'package':str(source),'codex':str(codex),'units':units},indent=2))
            return
        if current.exists() and not current.is_symlink():raise ValueError('Refusing to replace a non-symlink current path')
        entry=home/'.local/bin/codex-shared'
        if entry.exists() and not entry.is_symlink():raise ValueError('Refusing to replace an existing codex-shared file')
    except (ValueError,OSError) as error:
        parser.error(str(error))
    # Snapshot the built package, dependencies and native binaries. Existing
    # sessions continue using their old executable; upgrades change only current.
    digest=hashlib.sha256()
    for folder in ['src','runtime','scripts','docs','assets','patches']:
        for item in sorted((source/folder).rglob('*')):
            if item.is_file() and '__pycache__' not in item.parts:
                digest.update(str(item.relative_to(source)).encode());digest.update(item.read_bytes())
    for name in ['package.json','package-lock.json','scratch/asar/package.json']:
        digest.update((source/name).read_bytes())
    digest.update(codex_version.encode())
    digest.update(node_version.encode())
    digest.update(codex.read_bytes())
    digest.update(node.read_bytes())
    digest.update(websocat.read_bytes())
    release=base/'releases'/digest.hexdigest()[:16]
    if not release.exists():
        staged=release.with_name(release.name+'.install-'+str(os.getpid()))
        staged.mkdir(parents=True,mode=0o700)
        for name in ['src','runtime','scripts','docs','node_modules']:
            if (source/name).exists():
                shutil.copytree(source/name,staged/name,symlinks=True,ignore=shutil.ignore_patterns('__pycache__'))
        (staged/'scratch').mkdir()
        shutil.copytree(source/'scratch/asar',staged/'scratch/asar',symlinks=True)
        for name in ['package.json','package-lock.json','README.md','LICENSE']:
            if (source/name).is_file():shutil.copy2(source/name,staged/name)
        bin_dir=staged/'bin';bin_dir.mkdir()
        for name,binary in {'codex':codex,'node':node,'websocat':websocat}.items():install_file(binary,bin_dir/name)
        host=codex.parent/'codex-code-mode-host'
        if host.is_file():install_file(host,bin_dir/host.name)
        for item in (source/'runtime').iterdir():
            if item.is_file():
                install_file(item,bin_dir/item.name);(bin_dir/item.name).chmod(0o755)
        files=[*bin_dir.iterdir(),staged/'package.json',staged/'package-lock.json',staged/'src/server/main.js',staged/'src/server/shared-compat.cjs']
        manifest={'codexVersion':codex_version,'source':str(source),'files':{str(item.relative_to(staged)):hashlib.sha256(item.read_bytes()).hexdigest() for item in files if item.is_file()}}
        (staged/'installation.json').write_text(json.dumps(manifest,indent=2)+'\n')
        staged.replace(release)
    verify_release_units(release,state,network,Path(sys.executable),app_tools)
    unit_dir=home/'.config/systemd/user';unit_dir.mkdir(parents=True,exist_ok=True)
    for name,content in units.items():save_unit(unit_dir/name,content)
    state.mkdir(parents=True,exist_ok=True,mode=0o700)
    config.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    staged=config.with_name('server.json.install-'+str(os.getpid()))
    staged.write_text(json.dumps(network,indent=2)+'\n');staged.chmod(0o600);staged.replace(config)
    staged=base/('current.next-'+str(os.getpid()));staged.symlink_to(release);staged.replace(current)
    entry.parent.mkdir(parents=True,exist_ok=True)
    if not entry.is_symlink() or entry.readlink()!=current/'bin/codex-shared':
        staged=entry.with_name('codex-shared.next-'+str(os.getpid()))
        staged.symlink_to(current/'bin/codex-shared');staged.replace(entry)
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    subprocess.run(['systemctl','--user','enable','codex-shared.service','codex-web.service'],check=True)
    if args.restart:subprocess.run(['systemctl','--user','restart','codex-web.service'],check=True)
    print(json.dumps({'release':str(release),'network':network,'config':str(config),'webRestarted':args.restart}))


if __name__=='__main__':
    main()
