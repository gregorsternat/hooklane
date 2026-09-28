#!/usr/bin/env python3
"""Validate the repository's small Markdown knowledge base, using only stdlib.

Use inline Markdown links and ATX headings in maintained docs. Fenced examples
are excluded. External links are not fetched; this is a deterministic local check.
"""
import datetime
import pathlib
import re
import subprocess
import sys
import urllib.parse


def prose(text):
    return re.sub(r"^(`{3,}|~{3,}).*?^\1[^\n]*$", "", text,
                  flags=re.MULTILINE | re.DOTALL)


def anchors(text):
    result = set()
    for heading in re.findall(r"^#{1,6}\s+(.+?)\s*#*\s*$", prose(text), re.MULTILINE):
        slug = re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")
        candidate, suffix = slug, 0
        while candidate in result:
            suffix += 1
            candidate = f"{slug}-{suffix}"
        result.add(candidate)
    return result


def check(root, files, today=None):
    today = today or datetime.date.today()
    errors, graph = [], {}
    markdown = {name for name in files if name.endswith('.md')}
    for name in sorted(markdown):
        path = root / name
        if not path.is_file():
            continue  # git may still list a tracked deletion
        text = path.read_text()
        graph[name] = set()
        if name == 'AGENTS.md' and len(text.splitlines()) > 100:
            errors.append(f'{name}: keep the entry point within 100 lines; move detail to docs/')
        live = name.startswith('docs/') and '/completed/' not in name and name != 'docs/exec-plans/template.md'
        if live:
            if not re.search(r'^Owner: \S.+$', text, re.MULTILINE):
                errors.append(f'{name}: add an accountable Owner: field')
            reviewed = re.search(r'^Last reviewed: (\d{4}-\d{2}-\d{2})$', text, re.MULTILINE)
            try:
                date = datetime.date.fromisoformat(reviewed[1] if reviewed else '')
                if not 0 <= (today - date).days <= 90:
                    raise ValueError()
            except ValueError:
                errors.append(f'{name}: review against code, then set Last reviewed: YYYY-MM-DD (within 90 days, not future)')
        if '/active/' in name or '/completed/' in name:
            status = 'completed' if '/completed/' in name else 'active'
            if f'Status: {status}' not in text.splitlines():
                errors.append(f'{name}: set Status: {status} to match the plan directory')
            for section in ['Outcome', 'Progress', 'Decisions', 'Validation', 'Remaining work']:
                if f'## {section}' not in text.splitlines():
                    errors.append(f'{name}: add the {section} section from the plan template')
            if status == 'completed' and '- [ ]' in text:
                errors.append(f'{name}: resolve unchecked work or move it to the debt tracker before completing')
        for match in re.finditer(r'\[[^\]\n]*\]\(([^)\s]+)\)', prose(text)):
            link = urllib.parse.urlsplit(match[1].strip('<>'))
            if link.scheme or link.netloc:
                continue
            target = (path.parent / urllib.parse.unquote(link.path)).resolve() if link.path else path.resolve()
            try:
                relative = target.relative_to(root.resolve()).as_posix()
            except ValueError:
                errors.append(f'{name}: link escapes the repository: {match[1]}')
                continue
            if not target.exists():
                errors.append(f'{name}: broken link {match[1]}; update the link or restore its target')
                continue
            if target.is_dir():
                target = target / 'README.md'
                relative += '/README.md'
            if target.suffix == '.md' and target.is_file():
                graph[name].add(relative)
                if link.fragment and urllib.parse.unquote(link.fragment) not in anchors(target.read_text()):
                    errors.append(f'{name}: missing heading {match[1]}; use the target heading anchor')
    reached, pending = set(), ['AGENTS.md']
    while pending:
        name = pending.pop()
        if name not in reached:
            reached.add(name)
            pending.extend(graph.get(name, ()))
    for name in sorted(graph):
        if name.startswith('docs/') and name not in reached:
            errors.append(f'{name}: orphan document; link it from docs/index.md or a linked plan index')
    for required in ['AGENTS.md', 'docs/index.md', 'docs/architecture.md', 'docs/principles.md',
                     'docs/harness.md', 'docs/quality.md', 'docs/exec-plans/index.md',
                     'docs/exec-plans/tech-debt-tracker.md']:
        if not (root / required).is_file():
            errors.append(f'{required}: required knowledge entry is missing')
    return errors


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    files = subprocess.check_output(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root
    ).decode().split('\0')
    errors = check(root, files)
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        return 1
    print('Documentation links, ownership, freshness, plans and navigation passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
