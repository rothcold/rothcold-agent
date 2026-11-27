"""Verify the wheel allowlist and RECORD, then stage only plugin files (no install)."""
import base64
import csv
import hashlib
import io
import sys
from pathlib import Path
from zipfile import ZipFile

wheel, plugins = map(Path, sys.argv[1:])
package = {f'rothcold_agent/{name}' for name in (
    '__init__.py', 'adapter.py', 'plugin.yaml', 'thread_titles.py',
)}
metadata = wheel.name.removesuffix('-py3-none-any.whl') + '.dist-info'
license_file = f'{metadata}/licenses/LICENSE'
expected = package | {license_file} | {f'{metadata}/{name}' for name in ('WHEEL', 'METADATA', 'RECORD')}
with ZipFile(wheel) as archive:
    files = [member.filename for member in archive.infolist() if not member.is_dir()]
    if set(files) != expected or len(files) != len(expected):
        raise ValueError(f'Unexpected wheel contents: {files}')
    record = f'{metadata}/RECORD'
    rows = list(csv.reader(io.StringIO(archive.read(record).decode())))
    if {row[0] for row in rows} != expected or len(rows) != len(expected):
        raise ValueError('Incomplete wheel RECORD')
    for name, digest, length in rows:
        if name != record:
            body = archive.read(name)
            actual = base64.urlsafe_b64encode(hashlib.sha256(body).digest()).decode().rstrip('=')
            if digest != 'sha256=' + actual or length != str(len(body)):
                raise ValueError(f'Invalid wheel RECORD: {name}')
    (plugins/'rothcold_agent').mkdir(parents=True, exist_ok=False)
    for name in sorted(package):
        archive.extract(name, plugins)
    (plugins/'rothcold_agent'/'LICENSE').write_bytes(archive.read(license_file))
print(f'Staged {len(package) + 1} verified files from {wheel.name}')
