import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from harness import configuration, compose_env, project_name


class HarnessIsolationTests(unittest.TestCase):
    def test_checkouts_get_distinct_projects_and_stable_private_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = pathlib.Path(directory) / 'one', pathlib.Path(directory) / 'two'
            first.mkdir()
            second.mkdir()
            self.assertNotEqual(project_name(first), project_name(second))
            initial = configuration(first, create=True)
            self.assertEqual(initial, configuration(first, create=True))
            self.assertNotEqual(initial, configuration(second, create=True))
            self.assertEqual((first / '.harness/config.json').stat().st_mode & 0o777, 0o600)
            alias = pathlib.Path(directory) / 'alias'
            alias.symlink_to(first)
            self.assertEqual(project_name(first), project_name(alias))

    def test_invalid_key_file_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            configuration(root, create=True)
            path = root / '.harness/config.json'
            path.write_text('{}')
            with self.assertRaises(ValueError):
                configuration(root, create=True)
            self.assertEqual(path.read_text(), '{}')

    def test_parent_project_and_credentials_do_not_override_harness(self):
        with tempfile.TemporaryDirectory() as directory:
            config = configuration(pathlib.Path(directory), create=True)
            with patch.dict(os.environ, {'COMPOSE_PROJECT_NAME': 'production', 'COMPOSE_FILE': 'other.yaml',
                                         'ADMIN_TOKEN': 'production', 'HARNESS_ADMIN_TOKEN': 'production'}):
                env = compose_env(config)
            self.assertNotIn('COMPOSE_PROJECT_NAME', env)
            self.assertNotIn('COMPOSE_FILE', env)
            self.assertEqual(env['ADMIN_TOKEN'], config['ADMIN_TOKEN'])
            self.assertEqual(env['HARNESS_ADMIN_TOKEN'], config['ADMIN_TOKEN'])


if __name__ == '__main__':
    unittest.main()
