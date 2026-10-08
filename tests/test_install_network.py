import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/install-services.py'
spec=importlib.util.spec_from_file_location('install_services',SCRIPT)
installer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class NetworkInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='codex-web-network-')
        self.config=Path(self.temp.name)/'server.json'

    def tearDown(self):
        self.temp.cleanup()

    def test_first_install_is_local_and_lan_is_explicit(self):
        self.assertEqual(installer.network_settings(self.config),{'host':'127.0.0.1','port':8214})
        self.assertEqual(installer.network_settings(self.config,access='lan',port=9000),{'host':'0.0.0.0','port':9000})

    def test_upgrades_preserve_settings_and_explicit_options_override_them(self):
        self.config.write_text(json.dumps({'host':'0.0.0.0','port':9000}))
        self.assertEqual(installer.network_settings(self.config),{'host':'0.0.0.0','port':9000})
        self.assertEqual(installer.network_settings(self.config,access='local'),{'host':'127.0.0.1','port':9000})
        self.assertEqual(installer.network_settings(self.config,host='192.168.1.11',port=8214),{'host':'192.168.1.11','port':8214})

    def test_invalid_values_cannot_enter_a_service_command(self):
        for host in ['0.0.0.0 --port 1','127.0.0.1\nExecStart=/bin/false','fe80::1%eth0']:
            with self.subTest(host=host),self.assertRaises(ValueError):
                installer.network_settings(self.config,host=host)
        for port in [0,65536,-1,'8214',True]:
            with self.subTest(port=port),self.assertRaises(ValueError):
                installer.network_settings(self.config,port=port)
        self.config.write_text('{broken')
        with self.assertRaises(ValueError):
            installer.network_settings(self.config)

    def test_units_quote_package_paths_and_set_selected_network(self):
        current=Path('/tmp/Codex Web % files/current')
        units=installer.service_units(current,Path('/tmp/Web state'),{'host':'0.0.0.0','port':9000},Path('/usr/bin/python3'))
        self.assertIn('--host 0.0.0.0 --port 9000',units['codex-web.service'])
        self.assertIn('Codex Web %% files/current/bin/node',units['codex-web.service'])
        self.assertIn('ExecStart=:',units['codex-web.service'])
        self.assertIn('WorkingDirectory=/tmp/Web state\n',units['codex-web.service'])
        self.assertIn('CODEX_UNIX_SOCKET=%t/codex-shared/app.sock',units['codex-shared.service'])

    def test_first_install_validates_snapshot_before_current_exists(self):
        release=Path(self.temp.name)/'releases/build'
        current=Path(self.temp.name)/'current'
        def verify(command,**options):
            self.assertEqual(command[:3],['systemd-analyze','--user','verify'])
            for filename in command[3:]:
                content=Path(filename).read_text()
                self.assertIn(str(release),content)
                self.assertNotIn(str(current),content)
            self.assertTrue(options['check'])
        with patch.object(installer.subprocess,'run',side_effect=verify):
            installer.verify_release_units(release,Path(self.temp.name)/'state',{'host':'127.0.0.1','port':8214},Path('/usr/bin/python3'))
        self.assertFalse(current.exists())


if __name__=='__main__':
    unittest.main()
