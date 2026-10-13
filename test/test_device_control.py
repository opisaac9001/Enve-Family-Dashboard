import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'device_control', Path(__file__).resolve().parents[1] / 'pi-native/device-control.py'
)
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class DeviceControlTest(unittest.TestCase):
    def test_rejects_extra_arguments_and_arbitrary_commands(self):
        for arguments in ([], ['reboot', 'now'], ['shell', 'id'], ['timezone'],
                          ['restart-display', 'other.service']):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                control.commands(arguments)

    def test_timezone_must_be_installed_and_is_passed_as_one_argument(self):
        with patch.object(control.subprocess, 'check_output', return_value='Etc/UTC\nAmerica/New_York\n'):
            commands = control.commands(['timezone', 'America/New_York'])
            self.assertEqual(commands[0],
                             ['/usr/bin/timedatectl', 'set-timezone', 'America/New_York'])
            self.assertEqual(commands[1][-3:],
                             ['/usr/bin/systemctl', 'restart', 'enve-family.service'])
            with self.assertRaises(ValueError):
                control.commands(['timezone', 'Etc/UTC; reboot'])

    def test_restart_only_targets_running_enve_displays(self):
        def active(arguments, **kwargs):
            return subprocess.CompletedProcess(arguments, 0 if 'full-display' in arguments[-1] else 3)
        with patch.object(control.subprocess, 'run', side_effect=active):
            self.assertEqual(control.commands(['restart-display']),
                             [['/usr/bin/systemctl', '--no-block', 'restart',
                               'enve-family-full-display.service']])
        with patch.object(control.subprocess, 'run', return_value=subprocess.CompletedProcess([], 3)):
            with self.assertRaises(ValueError):
                control.commands(['restart-display'])

    def test_power_actions_allow_response_before_shutdown(self):
        for action in ('reboot', 'poweroff'):
            command = control.commands([action])[0]
            self.assertIn('--on-active=3s', command)
            self.assertEqual(command[-2:], ['/usr/bin/systemctl', action])

    def test_requires_root_before_running_any_commands(self):
        with patch.object(control.os, 'geteuid', return_value=1000), \
                patch.object(control.subprocess, 'run') as run:
            with self.assertRaises(PermissionError):
                control.main()
            run.assert_not_called()
