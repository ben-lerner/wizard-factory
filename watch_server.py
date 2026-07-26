#!/usr/bin/env python3
"""Run Wizard Factory and restart it when its source files change."""
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SELF = Path(__file__).resolve()


def snapshot():
    paths = [ROOT / 'server.py', SELF, *(ROOT / 'static').rglob('*')]
    out = {}
    for p in paths:
        try:
            st = p.stat()
        except OSError:
            continue
        if stat.S_ISREG(st.st_mode):
            out[p] = (st.st_mtime_ns, st.st_size)
    return out


def stop(proc):
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def shutdown(_signum, _frame):
    raise SystemExit


def main():
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    state = snapshot()
    while True:
        proc = subprocess.Popen([sys.executable, ROOT / 'server.py'])
        try:
            while proc.poll() is None:
                time.sleep(.5)
                new = snapshot()
                if new == state:
                    continue
                changed = set(state) ^ set(new) | {p for p in state.keys() & new.keys() if state[p] != new[p]}
                state = new
                stop(proc)
                if SELF in changed:
                    return
                time.sleep(.2)
        except BaseException:
            if proc.poll() is None:
                stop(proc)
            raise
        if proc.returncode:
            time.sleep(1)


if __name__ == '__main__':
    main()
