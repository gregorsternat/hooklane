#!/usr/bin/env python3
"""Operate a disposable Compose project bound to this checkout's real path."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import secrets
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
KEYS = ('ADMIN_TOKEN', 'INGEST_TOKEN', 'ENCRYPTION_KEY', 'DB_PASSWORD', 'SIGNING_SECRET')


def project_name(root):
    return 'hooklane-harness-' + hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]


def configuration(root, create=False):
    directory = root / '.harness'
    path = directory / 'config.json'
    if create and not path.exists():
        directory.mkdir(mode=0o700, exist_ok=True)
        # Exclusive creation prevents parallel launches from replacing the key.
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'w') as handle:
                json.dump({key: secrets.token_hex(32) for key in KEYS}, handle)
    if not path.exists():
        raise ValueError('No harness configuration. Run make harness-up first.')
    config = json.loads(path.read_text())
    if not isinstance(config, dict) or set(config) != set(KEYS) or any(
        not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value)
        for value in config.values()
    ):
        raise ValueError('Invalid .harness/config.json; restore the original file before starting its database.')
    path.chmod(0o600)
    return config


def compose_env(config):
    env = {key: value for key, value in os.environ.items() if not key.startswith('COMPOSE_')}
    env.update({'HARNESS_' + key: value for key, value in config.items()})
    # The base file is interpolated before overrides. Supply local values even
    # when a caller has exported a production environment. No .env is loaded.
    env.update({key: config[key] for key in ('ADMIN_TOKEN', 'INGEST_TOKEN', 'ENCRYPTION_KEY')})
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['up', 'status', 'logs', 'metrics', 'down'])
    args = parser.parse_args()
    config = configuration(ROOT, create=args.action == 'up')
    command = ['docker', 'compose', '--env-file', '/dev/null', '-p', project_name(ROOT),
               '-f', 'compose.yaml', '-f', 'compose.smoke.yaml', '-f', 'compose.harness.yaml']
    env = compose_env(config)

    def compose(*arguments, capture=False):
        return subprocess.run(command + list(arguments), cwd=ROOT, env=env, check=True,
                              text=True, stdout=subprocess.PIPE if capture else None).stdout

    if args.action == 'down':
        compose('down', '--volumes', '--remove-orphans', '--timeout', '30')
        print('Removed only this checkout\'s disposable harness containers and volume.')
        return
    if args.action == 'logs':
        compose('logs', '--no-color', '--tail', '100', 'app', 'receiver')
        return
    if args.action == 'up':
        compose('up', '--build', '--wait', '--wait-timeout', '120')
    address = compose('port', 'app', '8088', capture=True).strip()
    if not re.fullmatch(r'127\.0\.0\.1:\d+', address):
        raise ValueError('Harness is not running on loopback; run make harness-up and inspect Docker.')
    base = 'http://' + address
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    if args.action == 'metrics':
        request = urllib.request.Request(base + '/api/v1/metrics',
                                         headers={'Authorization': 'Bearer ' + config['ADMIN_TOKEN']})
        with opener.open(request, timeout=8) as response:
            print(response.read().decode(), end='')
        return
    for endpoint in ['/healthz', '/readyz']:
        with opener.open(base + endpoint, timeout=5) as response:
            print(f'{endpoint}: HTTP {response.status}')
    print('Project: ' + project_name(ROOT))
    print('Console: ' + base)
    print('PostgreSQL: ' + compose('port', 'db', '5432', capture=True).strip())
    print('Receiver: http://receiver:8099/webhook (inside this Compose network)')
    print('Credentials: .harness/config.json (private local file; never commit or paste into evidence)')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        # Driver errors or response bodies are deliberately not dumped.
        print(f'Harness command failed ({type(exc).__name__}). Check Docker and .harness/config.json; see docs/harness.md.', file=sys.stderr)
        sys.exit(1)
