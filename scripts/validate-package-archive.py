#!/usr/bin/env python3
"""Reject archive members that could escape or alter the extraction tree."""

import sys
import tarfile
from pathlib import PurePosixPath


def validate(path: str) -> None:
    with tarfile.open(path, "r:gz") as archive:
        for member in archive.getmembers():
            member_path = PurePosixPath(member.name)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise ValueError(f"unsafe package archive path: {member.name!r}")
            if not (member.isdir() or member.isfile()):
                raise ValueError(f"unsupported package archive member type: {member.name!r}")


if __name__ == "__main__":
    try:
        validate(sys.argv[1])
    except (IndexError, OSError, tarfile.TarError, ValueError) as error:
        print(f"Package archive validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
