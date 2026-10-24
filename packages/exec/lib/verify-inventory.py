#!/usr/bin/env python3
"""Check that the tree this job is about to train on is the tree that was packed.

Why this runs on the node and not only on the laptop: the archive is unpacked by Ray, in a container
this plugin cannot see, and the job's own training command would happily read a file that arrived
truncated, an untracked module that did not arrive at all, or a directory left over from a previous
working directory. Comparing the manifest shipped inside the package against the bytes actually on
disk is the only check that happens *after* the unpack.

It prints one line — `REPRISE_INVENTORY {json}` — because the driver log is the only channel back,
and it exits non-zero on a mismatch so the job stops instead of training on a tree nobody described.
The adapter reads that line and reports the mismatch as a `conflict`: the fact plane disagreeing
with itself, which is a finding, not a candidate defect.

Usage: python3 .reprise/verify_inventory.py            (from the unpacked package root)
"""

import hashlib
import json
import os
import sys

MANIFEST = os.path.join(".reprise", "archive.json")
MARKER = "REPRISE_INVENTORY"


def digest(path):
    sha = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            sha.update(block)
    return sha.hexdigest()


def main():
    try:
        with open(MANIFEST, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except Exception as error:  # noqa: BLE001 — any failure here is "the package is not what we sent"
        print(f"{MARKER} " + json.dumps({"ok": False, "error": f"cannot read {MANIFEST}: {error}"}))
        return 1

    missing, altered = [], []
    for entry in manifest.get("entries", []):
        path = entry["path"]
        if not os.path.isfile(path):
            missing.append(path)
            continue
        if digest(path) != entry["sha256"]:
            altered.append(path)

    report = {
        "ok": not missing and not altered,
        "base_ref": manifest.get("base_ref"),
        "checked": len(manifest.get("entries", [])),
        "missing": missing,
        "altered": altered,
        # Named explicitly so the node's answer says what the change was, not just how many files it
        # holds: an untracked module is the common shape of a structural candidate.
        "untracked": manifest.get("untracked", []),
        "changed": manifest.get("changed", []),
    }
    print(f"{MARKER} " + json.dumps(report, sort_keys=True))

    if not report["ok"]:
        sys.stderr.write(
            "reprise: the unpacked tree does not match the package manifest "
            f"({len(missing)} missing, {len(altered)} altered); refusing to train on it\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())