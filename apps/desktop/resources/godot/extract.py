"""Extract pinned Godot archives with path validation and executable modes."""

import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import zipfile


def extract(archive, destination, strip_templates=False):
    root = Path(destination).resolve()
    with zipfile.ZipFile(archive) as source:
        entries = []
        total = 0
        seen = set()
        for info in source.infolist():
            name = info.filename
            if "\\" in name or ":" in name or "\x00" in name:
                raise ValueError("unsafe archive path")
            parts = PurePosixPath(name).parts
            if name.startswith("/") or ".." in parts:
                raise ValueError("archive path escapes installation")
            if strip_templates:
                if not parts or parts[0] != "templates":
                    raise ValueError("unexpected export template archive layout")
                parts = parts[1:]
            if not parts:
                continue
            target = root.joinpath(*parts)
            if target in seen:
                raise ValueError("duplicate archive path")
            seen.add(target)
            total += info.file_size
            if total > 10 * 1024**3:
                raise ValueError("archive exceeds extraction budget")
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                link = source.read(info).decode("utf-8")
                resolved = (target.parent / link).resolve()
                if os.path.isabs(link) or not resolved.is_relative_to(root):
                    raise ValueError("archive symlink escapes installation")
            entries.append((info, target, mode))
        for info, target, mode in entries:
            target.parent.mkdir(parents=True, exist_ok=True)
            if info.is_dir():
                target.mkdir(exist_ok=True)
            elif stat.S_ISLNK(mode):
                os.symlink(source.read(info).decode("utf-8"), target)
            else:
                with source.open(info) as reader, target.open("wb") as writer:
                    shutil.copyfileobj(reader, writer)
                if os.name != "nt":
                    target.chmod((mode & 0o777) or 0o644)


if __name__ == "__main__":
    extract(sys.argv[1], sys.argv[2], len(sys.argv) > 3 and sys.argv[3] == "templates")
