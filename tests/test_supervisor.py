import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import unittest

SUPERVISOR=Path(__file__).resolve().parents[1]/'runtime/supervise-shared.py'
class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='codex-shared-supervisor-')
        self.root=Path(self.temp.name)
        self.marker=self.root/'started'
        self.fake=self.root/'codex'
        self.fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_MARKER"\nexec sleep 60\n')
        self.fake.chmod(0o755)
        self.alias=self.root/'runtime/app.sock'
        self.alias.parent.mkdir()
        self.process=None
        self.listener=None
    def launch(self):
        self.process=subprocess.Popen(['python3',str(SUPERVISOR)],env={**os.environ,'CODEX_UNIX_SOCKET':str(self.alias),'CODEX_SHARED_BINARY':str(self.fake),'TEST_MARKER':str(self.marker)},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def wait_marker(self):
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            if self.marker.exists():return
            if self.process.poll() is not None:self.fail(self.process.communicate())
            time.sleep(0.05)
        self.fail('Supervisor did not start its child')
    def make_listener(self):
        self.target=self.root/'actual.sock'
        self.listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.listener.bind(str(self.target));self.listener.listen()
        self.alias.symlink_to(self.target)
    def stop(self):
        self.process.send_signal(signal.SIGTERM)
        stdout,stderr=self.process.communicate(timeout=8)
        self.assertEqual(self.process.returncode,0,(stdout,stderr))
        return stdout
    def tearDown(self):
        if self.process and self.process.poll() is None:self.stop()
        if self.listener:self.listener.close()
        self.temp.cleanup()
    def test_adopts_external_listener_without_removing_alias_or_stopping_it(self):
        self.make_listener();before=self.alias.lstat().st_ino
        self.launch();time.sleep(0.3)
        text=self.stop()
        self.assertIn('existing shared app-server',text)
        self.assertEqual(self.alias.lstat().st_ino,before)
        self.assertFalse(self.marker.exists())
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:client.connect(str(self.alias))
    def test_starts_a_child_when_no_listener_exists(self):
        self.launch();self.wait_marker();self.stop()
        self.assertEqual(self.marker.read_text().splitlines(),['app-server','--listen','unix://'+str(self.alias)])
    def test_recovers_after_an_external_listener_disappears_without_unlinking(self):
        self.make_listener();before=self.alias.lstat().st_ino
        self.launch();time.sleep(0.3);self.listener.close();self.listener=None
        self.wait_marker();self.stop()
        self.assertEqual(self.alias.lstat().st_ino,before)
if __name__=='__main__':unittest.main()
