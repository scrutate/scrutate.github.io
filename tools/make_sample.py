"""Write playground/samples/scrutate-src.json: the text files of scrutate's source at one commit.

    python3 tools/make_sample.py ../scrutate <commit>
"""
import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path

PARTS = ["crates", "vendor", "tools"]
OUT = Path(__file__).resolve().parent.parent / "playground" / "samples" / "scrutate-src.json"


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: python3 tools/make_sample.py SCRUTATE_CHECKOUT COMMIT")
    repo, commit = sys.argv[1], sys.argv[2]
    sha = subprocess.run(["git", "-C", repo, "rev-parse", "--short", commit], capture_output=True, text=True, check=True).stdout.strip()
    tar = subprocess.run(["git", "-C", repo, "archive", commit, *PARTS], capture_output=True, check=True).stdout
    files = []
    with tarfile.open(fileobj=io.BytesIO(tar)) as t:
        for m in t.getmembers():
            if not m.isfile():
                continue
            data = t.extractfile(m).read()
            if b"\0" in data[:8192]:
                continue
            try:
                files.append([m.name, data.decode("utf-8")])
            except UnicodeDecodeError:
                continue
    files.sort()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"name": "scrutate's own source", "commit": sha, "files": files}, f, separators=(",", ":"))
    print(f"{OUT}: {len(files)} files, {sum(len(c.encode()) for _, c in files) / 1e6:.1f} MB, commit {sha}")


if __name__ == "__main__":
    main()
