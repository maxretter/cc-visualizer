"""Records `/viz demo` in a real Claude Code session, as an asciicast v2 file.

Starts `claude --plugin-dir .` from the repository in a pseudo-terminal of a
fixed size, waits for its prompt, types `/viz demo`, records the demo, and
leaves. If a dialog shows instead (trust this folder, an MCP server, an API
key, a login), it stops: the Enter that sends the command would answer it.
The band plays as your saved `/viz` settings say (mode, theme, place);
nothing is sent to the model. Standard library only.

usage: python3 record.py OUT.cast [--cols 100] [--rows 30] [--startup 60] [--settle 5] [--play 15]
"""
import argparse
import codecs
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument('out')
parser.add_argument('--cols', type=int, default=100)
parser.add_argument('--rows', type=int, default=30)
parser.add_argument('--startup', type=float, default=60, help='the most seconds to wait for the prompt')
parser.add_argument('--settle', type=float, default=5, help='seconds to let the session settle once the prompt shows')
parser.add_argument('--play', type=float, default=15, help='seconds to record after the command')
args = parser.parse_args()

repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Escape sequences: CSI, OSC, and the two-character ones.
ESCAPES = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])')
# What a dialog says and the prompt never does, in lower case. One up at the
# start (trust this folder, approve an MCP server, use an API key, log in)
# would take the Enter that sends `/viz demo` as its answer.
DIALOGS = ('trust', 'do you want', 'enter to confirm', 'esc to cancel', 'press enter', 'select login method')

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
    """Records what the session draws for `seconds`: False if it ended first."""
    end = time.monotonic() + seconds
    while (left := end - time.monotonic()) > 0:
        ready, _, _ = select.select([fd], [], [], min(left, 0.05))
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        if text := decoder.decode(data):
            events.append([now(), 'o', text])
    return True


def leave(message):
    """Ends the session, and the script with `message`."""
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    raise SystemExit(f'record.py: {message}')


def shown():
    """All the session has drawn so far, less its escape sequences."""
    return ESCAPES.sub('', ''.join(data for _, kind, data in events if kind == 'o'))


def check():
    """Stops if a dialog has shown, before a key can answer it."""
    text = shown().lower()
    for words in DIALOGS:
        if words in text:
            leave(f'a dialog is up ("{words}"). Run `claude` in {repo} by hand, answer it, and try again.')


def wait_for_prompt():
    """Records until the prompt box's `❯` shows and the session settles. A
    dialog's list has a `❯` too, so its words are looked for all along."""
    end = time.monotonic() + args.startup
    while '❯' not in shown():
        if time.monotonic() > end:
            leave(f'no prompt after {args.startup:g}s. Run `claude` in {repo} by hand to see what it shows.')
        if not pump(0.25):
            leave('claude ended before its prompt showed.')
        check()
    if not pump(args.settle):
        leave('claude ended before the demo.')
    check()


wait_for_prompt()
events.append([now(), 'm', 'typing'])
for ch in '/viz demo':
    os.write(fd, ch.encode())
    pump(0.06)
pump(0.6)
# A dialog that came up while typing would take the Enter.
check()
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
