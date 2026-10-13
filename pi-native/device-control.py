#!/usr/bin/python3
import os
import subprocess
import sys
import json
import socket

DISPLAY_SERVICES = (
    'enve-family-full-display.service',
    'enve-family-display.service',
    'enve-family-vulkan-display.service',
)


def commands(arguments):
    if len(arguments) == 2 and arguments[0] == 'timezone':
        zones = subprocess.check_output(
            ['/usr/bin/timedatectl', 'list-timezones'], text=True, timeout=5
        ).splitlines()
        if arguments[1] not in zones:
            raise ValueError('Unknown time zone')
        return [['/usr/bin/timedatectl', 'set-timezone', arguments[1]],
                ['/usr/bin/systemd-run', '--quiet', '--collect',
                 '--unit=enve-device-timezone', '--on-active=3s',
                 '/usr/bin/systemctl', 'restart', 'enve-family.service']]
    if arguments == ['restart-display']:
        active = [service for service in DISPLAY_SERVICES if subprocess.run(
            ['/usr/bin/systemctl', 'is-active', '--quiet', service], timeout=5
        ).returncode == 0]
        if not active:
            raise ValueError('No display service is running')
        return [['/usr/bin/systemctl', '--no-block', 'restart', service] for service in active]
    if arguments in (['reboot'], ['poweroff']):
        action = arguments[0]
        return [['/usr/bin/systemd-run', '--quiet', '--collect', f'--unit=enve-device-{action}',
                 '--on-active=3s', '/usr/bin/systemctl', action]]
    raise ValueError('Unsupported action')


def main():
    if os.geteuid() != 0:
        raise PermissionError('Administrator access required')
    connection = None
    arguments = sys.argv[1:]
    if arguments == ['--socket']:
        connection = socket.socket(fileno=0)
        connection.settimeout(5)
        data = b''
        while b'\n' not in data:
            chunk = connection.recv(1024)
            if not chunk or len(data) + len(chunk) > 4096:
                raise ValueError('Invalid request')
            data += chunk
        arguments = json.loads(data)
        if not isinstance(arguments, list) or not all(isinstance(item, str) for item in arguments):
            raise ValueError('Invalid arguments')
    for command in commands(arguments):
        subprocess.run(command, check=True, timeout=10, env={
            'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'
        }, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if connection:
        connection.sendall(b'{"accepted":true}\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, PermissionError, OSError, subprocess.SubprocessError):
        sys.exit('Device action failed')
