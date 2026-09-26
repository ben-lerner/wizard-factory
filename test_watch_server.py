import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import watch_server


class WatchServerTest(unittest.TestCase):
    def test_local_source_changes_trigger_restart_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(watch_server, 'ROOT', root):
                before = watch_server.snapshot()
                source = root / 'server.py'
                source.write_text('# server v1\n')
                added = watch_server.snapshot()
                self.assertNotEqual(before, added)
                source.write_text('# server with updated quota handling\n')
                self.assertNotEqual(added, watch_server.snapshot())
