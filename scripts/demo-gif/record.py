"""Records `/viz demo` in a real Claude Code session, as an asciicast v2 file.

Starts `claude --plugin-dir .` from the repository in a pseudo-terminal of a
fixed size, waits for it to start, types `/viz demo`, records the demo, and
leaves. The band plays as your saved `/viz` settings say (mode, theme, place);
nothing is sent to the model. Standard library only.

usage: python3 record.py OUT.cast [--cols 100] [--rows 30] [--startup 15] [--play 15]
"""
import argparse
import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument('out')
parser.add_argument('--cols', type=int, default=100)
parser.add_argument('--rows', type=int, default=30)
parser.add_argument('--startup', type=float, default=15, help='seconds to let Claude Code start')
parser.add_argument('--play', type=float, default=15, help='seconds to record after the command')
args = parser.parse_args()

repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.cols, 0, 0))
    os.chdir(repo)
    # A session started from inside another inherits its markers (and warns
    # about them): start this one clean.
    env = {k: v for k, v in os.environ.items() if not k.startswith('CLAUDE')}
    env.update(TERM='xterm-256color', COLORTERM='truecolor')
    os.execvpe('claude', ['claude', '--plugin-dir', '.'], env)

start = time.monotonic()
events = []
decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')


def now():
    return round(time.monotonic() - start, 4)


def pump(seconds):
    """Records what the session draws for `seconds`."""
    end = time.monotonic() + seconds
    while (left := end - time.monotonic()) > 0:
        ready, _, _ = select.select([fd], [], [], min(left, 0.05))
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        if text := decoder.decode(data):
            events.append([now(), 'o', text])


pump(args.startup)
events.append([now(), 'm', 'typing'])
for ch in '/viz demo':
    os.write(fd, ch.encode())
    pump(0.06)
pump(0.6)
events.append([now(), 'm', 'demo'])
os.write(fd, b'\r')
pump(args.play)

# Leave: ctrl+c twice.
for _ in range(2):
    os.write(fd, b'\x03')
    pump(0.5)
pump(2)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass

with open(args.out, 'w') as f:
    f.write(json.dumps({'version': 2, 'width': args.cols, 'height': args.rows, 'env': {'TERM': 'xterm-256color'}}) + '\n')
    for event in events:
        f.write(json.dumps(event) + '\n')
print(f'{args.out}: {len(events)} events over {events[-1][0]:.1f}s')
