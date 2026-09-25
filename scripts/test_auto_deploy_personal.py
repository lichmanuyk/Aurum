"""Safety checks for the personal updater without GitHub, Docker or real finances."""
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import auto_deploy_personal as deployer


class AutoDeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.main = Path(self.temp.name) / 'Aurum'
        self.root = self.main / '.deploy/personal'
        self.root.mkdir(parents=True)
        (self.main / '.env.personal').write_text('AURUM_WEB_PORT=3003\nAURUM_POSTGRES_DB=aurum_personal\nAURUM_BIND_ADDRESS=127.0.0.1\n')
        env = self.root / '.env.personal'
        env.symlink_to(self.main / '.env.personal')
        for name, value in [('ROOT', self.root), ('ENV', env)]:
            patcher = patch.object(deployer, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_unchanged_branch_does_not_backup_or_restart(self):
        def fake_run(*args, capture=False):
            if args[-1] == '--show-toplevel':
                return str(self.root)
            if args[-1] in ('HEAD', 'FETCH_HEAD'):
                return 'a' * 40
            self.assertNotIn('backup_personal.py', str(args))
        with patch.object(deployer, 'run', side_effect=fake_run), patch.object(deployer, 'health') as health:
            deployer.deploy()
            health.assert_not_called()

    def test_failed_update_restores_previous_checkout(self):
        calls = []

        def fake_run(*args, capture=False):
            calls.append(args)
            if args[-1] == '--show-toplevel':
                return str(self.root)
            if args[-1] == 'HEAD':
                return 'a' * 40
            if args[-1] == 'FETCH_HEAD':
                return 'b' * 40
            if args[-1] == '--porcelain':
                return ''
            if args[:2] == ('docker', 'compose') and sum(c[:2] == ('docker', 'compose') for c in calls) == 1:
                raise subprocess.CalledProcessError(1, args)

        with patch.object(deployer, 'run', side_effect=fake_run), \
             patch.object(deployer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)), \
             patch.object(deployer, 'health'):
            with self.assertRaises(subprocess.CalledProcessError):
                deployer.deploy()
        names = ['backup' if 'backup_personal.py' in str(c) else
                 'switch-new' if c[-1] == 'b' * 40 else
                 'switch-old' if c[-1] == 'a' * 40 and c[:2] == ('git', 'switch') else
                 'compose' if c[:2] == ('docker', 'compose') else '' for c in calls]
        self.assertEqual([n for n in names if n], ['backup', 'switch-new', 'compose', 'switch-old', 'compose'])
        self.assertEqual((self.root.parent / 'failed-target').read_text().strip(), 'b' * 40)

    def test_non_fast_forward_never_touches_data_or_docker(self):
        def fake_run(*args, capture=False):
            if args[-1] == '--show-toplevel':
                return str(self.root)
            if args[-1] == 'HEAD':
                return 'a' * 40
            if args[-1] == 'FETCH_HEAD':
                return 'b' * 40
            if args[-1] == '--porcelain':
                return ''
            self.assertNotIn('backup_personal.py', str(args))
            self.assertNotEqual(args[:2], ('docker', 'compose'))
        with patch.object(deployer, 'run', side_effect=fake_run), \
             patch.object(deployer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)):
            with self.assertRaisesRegex(RuntimeError, 'fast-forward'):
                deployer.deploy()


if __name__ == '__main__':
    unittest.main()
