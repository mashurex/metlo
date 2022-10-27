#!/usr/bin/env python3

import argparse
from base64 import b64encode
import secrets
import string
import subprocess
import os
import urllib.request


METLO_DIR = os.path.join(os.path.expanduser('~'), '.metlo')
ENV_PATH = os.path.join(METLO_DIR, '.env')
LICENSE_PATH = os.path.join(METLO_DIR, 'LICENSE_KEY')
FILES_TO_PULL = ['docker-compose.yaml', 'init.sql', 'metlo-config.yaml']
UPDATE_FILES_TO_PULL = ['docker-compose.yaml', 'init.sql']
IMAGES = ['backend', 'frontend', 'jobrunner', 'suricata-daemon']


def get_file(file_name):
    src = f'https://raw.githubusercontent.com/metlo-labs/metlo/master/{file_name}'
    request = urllib.request.Request(src)
    with urllib.request.urlopen(request) as response:
        data = response.read().decode('utf-8')
    with open(os.path.join(METLO_DIR, file_name), 'w') as f:
        f.write(data)


def get_current_ip():
    request = urllib.request.Request('http://checkip.amazonaws.com')
    with urllib.request.urlopen(request) as response:
        data = response.read().decode('utf-8')
    return data.strip('\n')


def gen_secret(l):
    return ''.join(
        secrets.choice(string.ascii_uppercase + string.ascii_lowercase)
        for _ in range(l)
    )


def write_env():
    encryption_key = b64encode(secrets.token_bytes(32)).decode('UTF-8')
    express_secret = gen_secret(32)
    clickhouse_user = gen_secret(16)
    clickhouse_password = gen_secret(16)
    instance_ip = get_current_ip()
    init_env_file = f'''
ENCRYPTION_KEY="{encryption_key}"
BACKEND_URL="http://{instance_ip}:8081"
EXPRESS_SECRET="{express_secret}"
CLICKHOUSE_USER="{clickhouse_user}"
CLICKHOUSE_PASSWORD="{clickhouse_password}"
SANDBOX_MODE="false"
DISABLE_LOGGING_STATS="false"
    '''.strip()
    with open(ENV_PATH, 'w') as f:
        f.write(init_env_file)


def init_env():
    if os.path.exists(ENV_PATH):
        return
    print('Initializing Environment...')
    write_env()


def pull_files():
    print('Pulling Files...')
    for f in FILES_TO_PULL:
        get_file(f)


def update_files():
    print('Pulling Updated Files...')
    for f in UPDATE_FILES_TO_PULL:
        get_file(f)


def pull_dockers():
    print('Pulling Docker Images...')
    for e in IMAGES:
        subprocess.run(['docker', 'pull', f'metlo/{e}'])


def init():
    if not os.path.exists(METLO_DIR):
        os.mkdir(METLO_DIR)
    init_env()
    pull_files()
    pull_dockers()


def start():
    subprocess.run(['docker-compose', 'up', '-d'], cwd=METLO_DIR)


def stop():
    subprocess.run(['docker-compose', 'down'], cwd=METLO_DIR)


def restart():
    subprocess.run(['docker-compose', 'restart'], cwd=METLO_DIR)


def status():
    subprocess.run(['docker-compose', 'ps'], cwd=METLO_DIR)


def update():
    pull_dockers()
    stop()
    update_files()
    start()


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest='command', required=True)

    init_cmd = subparsers.add_parser('init')
    init_env_cmd = subparsers.add_parser('init-env')
    start_cmd = subparsers.add_parser('start')
    stop_cmd = subparsers.add_parser('stop')
    status_cmd = subparsers.add_parser('status')
    restart_cmd = subparsers.add_parser('restart')
    update_cmd = subparsers.add_parser('update')

    args = parser.parse_args()

    command = args.command
    if command == 'init':
        init()
    elif command == 'init-env':
        init_env()
    elif command == 'start':
        start()
    elif command == 'stop':
        stop()
    elif command == 'restart':
        restart()
    elif command == 'update':
        update()
    elif command == 'status':
        status()


if __name__ == '__main__':
    main()