import datetime
import pathlib
import tempfile
import unittest

from check_docs import anchors, check


class DocumentationPolicyTests(unittest.TestCase):
    def validate(self, extra, entry='[Map](docs/index.md)'):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            docs = ['index', 'architecture', 'principles', 'harness', 'quality',
                    'exec-plans/index', 'exec-plans/tech-debt-tracker']
            files = {f'docs/{name}.md': '# Page\n\nOwner: maintainers\nLast reviewed: 2026-09-28\n' for name in docs}
            files['AGENTS.md'] = entry
            files['docs/index.md'] += '\n'.join(f'[Page]({name}.md)' for name in docs)
            files.update(extra)
            for name, text in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            return check(root, files, datetime.date(2026, 9, 28))

    def test_valid_graph_and_external_links(self):
        self.assertEqual(self.validate({}, '[Map](docs/index.md#page) [Web](https://example.com/missing)'), [])

    def test_broken_file_and_anchor(self):
        errors = self.validate({}, '[Map](docs/index.md#missing) [Lost](lost.md)')
        self.assertTrue(any('missing heading' in e for e in errors))
        self.assertTrue(any('broken link' in e for e in errors))

    def test_orphan_missing_owner_stale_and_future_dates(self):
        for date in ['2025-01-01', '2026-09-29', '2026-02-31']:
            errors = self.validate({'docs/orphan.md': f'# Lost\nLast reviewed: {date}\n'})
            for message in ['orphan document', 'Owner:', 'Last reviewed:']:
                self.assertTrue(any(message in e for e in errors), errors)

    def test_entry_limit_and_escaping_link(self):
        errors = self.validate({}, '[Escape](../outside.md)\n' + '\n' * 101)
        self.assertTrue(any('100 lines' in e for e in errors))
        self.assertTrue(any('escapes the repository' in e for e in errors))

    def test_completed_plan_requires_evidence_sections(self):
        errors = self.validate({'docs/exec-plans/completed/old.md': '# Done\nStatus: active\n- [ ] pending\n'})
        for message in ['Status: completed', 'Validation section', 'unchecked work']:
            self.assertTrue(any(message in e for e in errors), errors)
        self.assertFalse(any('Last reviewed:' in e for e in errors))

    def test_fenced_examples_and_duplicate_headings(self):
        self.assertEqual(anchors('# Title\n## Again\n## Again\n```md\n# Hidden\n```'), {'title', 'again', 'again-1'})
        self.assertEqual(self.validate({}, '[Map](docs/index.md)\n```md\n[Example](missing.md)\n```'), [])


if __name__ == '__main__':
    unittest.main()
