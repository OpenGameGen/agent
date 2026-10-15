"""Extract the pinned npm package without links or escaping paths."""
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile

root = Path(sys.argv[2]).resolve()
with tarfile.open(sys.argv[1], "r:gz") as source:
    total = 0
    seen = set()
    members = []
    for member in source.getmembers():
        parts = PurePosixPath(member.name).parts
        if not parts or parts[0] != "package" or ".." in parts or "\\" in member.name or ":" in member.name:
            raise ValueError("unsafe npm archive path")
        if not (member.isdir() or member.isfile()):
            raise ValueError("npm archive contains a link or special file")
        if len(parts) == 1:
            continue
        path = root.joinpath(*parts[1:])
        if path in seen:
            raise ValueError("duplicate npm archive path")
        seen.add(path)
        total += member.size
        if total > 100 * 1024**2:
            raise ValueError("npm archive exceeds extraction budget")
        members.append((member, path))
    for member, path in members:
        path.parent.mkdir(parents=True, exist_ok=True)
        if member.isdir():
            path.mkdir(exist_ok=True)
        else:
            with source.extractfile(member) as reader, path.open("xb") as writer:
                shutil.copyfileobj(reader, writer)
            path.chmod(member.mode & 0o777)
