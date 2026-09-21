import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import watch_server


class WatchServerTest(unittest.TestCase):
    def test_quota_reader_changes_trigger_restart_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(watch_server, 'QUOTA_ROOT', root):
                before = watch_server.snapshot()
                reader = root / 'claude_quota.py'
                reader.write_text('# reader v1\n')
                added = watch_server.snapshot()
                self.assertNotEqual(before, added)
                reader.write_text('# reader with updated cache handling\n')
                self.assertNotEqual(added, watch_server.snapshot())
