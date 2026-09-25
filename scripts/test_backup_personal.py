"""The daily backup must keep accepting the format emitted by the deployed API."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import backup_personal


class BackupFormatTests(unittest.TestCase):
    def test_old_and_current_versions_are_saved_but_unknown_version_is_rejected(self):
        for version in (4, 5, 6, 999):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = root / 'personal.env'
                config.write_text('AURUM_BASIC_AUTH_USER=test\nAURUM_BASIC_AUTH_PASSWORD=test\n')
                raw = json.dumps(dict(aurum_backup_version=version, accounts=[{}], transactions=[{}],
                    categories=[], assets=[], asset_valuations=[], crypto_holdings=[],
                    crypto_transactions=[], fx_rates=[])).encode()

                class Response:
                    status = 200
                    def __enter__(self): return self
                    def __exit__(self, *_): pass
                    def read(self): return raw

                def urlopen(request, timeout):
                    if request.headers['Authorization'] == 'Basic invalid':
                        raise HTTPError(request.full_url, 401, 'Unauthorized', {}, None)
                    return Response()

                with patch.object(backup_personal, 'CONFIG', config), \
                     patch.object(backup_personal, 'DEST', root / 'backups'), \
                     patch.object(backup_personal, 'urlopen', side_effect=urlopen):
                    if version == 999:
                        with self.assertRaisesRegex(ValueError, 'Unexpected backup version'):
                            backup_personal.main()
                        self.assertFalse((root / 'backups').exists())
                    else:
                        backup_personal.main()
                        saved = next((root / 'backups').glob('*.json'))
                        self.assertEqual(saved.read_bytes(), raw)
                        self.assertIn(hashlib.sha256(raw).hexdigest(), saved.with_suffix('.sha256').read_text())


if __name__ == '__main__':
    unittest.main()
