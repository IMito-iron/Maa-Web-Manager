#!/usr/bin/env python3
"""Prepare only the data bind paths resolved by Compose; never execute .env as shell."""
import json
import os
from pathlib import Path
import stat
import subprocess

config = json.loads(subprocess.check_output(['docker', 'compose', 'config', '--format', 'json']))
# This shared, non-secret device policy is consumed by UID 0 (cap_drop ALL) and
# UID 1000. Explicit modes avoid inheriting a deployment shell's private umask.
for mount in config['services']['device'].get('volumes', []):
    if mount.get('type') == 'bind' and mount['target'] == '/device-config':
        directory=Path(mount['source']);policy=directory/'devices.json'
        if directory.is_symlink() or policy.is_symlink() or not policy.is_file():
            raise SystemExit('Expected a regular device configuration')
        directory.chmod(0o755);policy.chmod(0o644)
targets = {
    'manager': {'/data', '/config', '/control', '/opt/maa/share/MaaResource'},
    'portal': {'/data'},
    'device': {'/stats', '/root/.android'},
}
for service, destinations in targets.items():
    for mount in config['services'][service].get('volumes', []):
        if mount.get('type') != 'bind' or mount['target'] not in destinations:
            continue
        directory = Path(mount['source'])
        if directory.is_symlink():
            raise SystemExit(f'Refusing symlink data directory: {directory}')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not directory.is_dir():
            raise SystemExit(f'Data directory not writable: {directory}')
        if service in ('manager', 'portal') and (directory.stat().st_uid != 1000 or not os.access(directory, os.W_OK)):
            raise SystemExit(f'Container UID 1000 must own {directory}')
        if service == 'device':
            private = mount['target'] == '/root/.android'
            owner = '0:0' if private else '0:1000'
            directory_mode = '700' if private else '750'
            file_mode = '600' if private else '640'
            # Docker supplies narrowly scoped ownership repair even when the caller
            # cannot inspect an existing root-owned 0700 ADB key directory.
            subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--user', '0:0',
                '--mount', f'type=bind,src={directory.resolve()},dst=/prepare',
                '--entrypoint', '/bin/sh', config['services']['gateway']['image'], '-ec',
                f'chown {owner} /prepare; chmod {directory_mode} /prepare; '
                'for f in /prepare/adbkey /prepare/adbkey.pub /prepare/scrcpy.log; do '
                'if [ -L "$f" ]; then echo "Refusing symlink" >&2; exit 1; fi; '
                f'if [ -e "$f" ]; then [ -f "$f" ]; chown {owner} "$f"; chmod {file_mode} "$f"; fi; done'], check=True)
            continue
# Shared control-state: manager (UID 1000) writes; device (UID 0, cap_drop ALL) reads.
for mount in config['services']['manager'].get('volumes', []):
    if mount.get('type') == 'bind' and mount['target'] == '/control-state':
        directory = Path(mount['source'])
        if directory.is_symlink():
            raise SystemExit('Refusing symlink control-state directory')
        directory.mkdir(mode=0o755, parents=True, exist_ok=True)
        if directory.stat().st_uid != 1000:
            raise SystemExit('Container UID 1000 must own control-state directory')
