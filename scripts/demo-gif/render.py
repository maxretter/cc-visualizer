"""Renders a recording of the demo (record.py) as a GIF of the band and the prompt under it.

Replays the recording through a terminal emulator (pyte), draws each frame
with Pillow, and encodes it with ffmpeg's palette filters. Block elements and
braille are drawn as shapes, so the bars are crisp whatever the font has.

usage: python render.py IN.cast OUT.gif [--start -1.5] [--seconds 17] [--fps 12] [--size 16] [--rows FIRST:LAST]

--start is in seconds from when the command is typed; --rows crops to those
screen rows (inclusive), found on their own when not given.
"""
import argparse
import json
import subprocess

import pyte
from PIL import Image, ImageDraw, ImageFont

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
BACKGROUND = (24, 24, 27)
FOREGROUND = (212, 212, 216)
PADDING = 12
# The 16 colors by pyte's names for them.
NAMED = {
    'black': (0, 0, 0),
    'red': (205, 49, 49),
    'green': (13, 188, 121),
    'brown': (229, 229, 16),
    'blue': (36, 114, 200),
    'magenta': (188, 63, 188),
    'cyan': (17, 168, 205),
    'white': (229, 229, 229),
    'brightblack': (118, 118, 118),
    'brightred': (241, 76, 76),
    'brightgreen': (35, 209, 139),
    'brightbrown': (245, 245, 67),
    'brightblue': (59, 142, 234),
    'brightmagenta': (214, 112, 214),
    'brightcyan': (41, 184, 219),
    'brightwhite': (255, 255, 255),
}
# Braille dot bits by column and row within the cell's 2x4 dots.
DOTS = [(0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08), (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80)]

parser = argparse.ArgumentParser()
parser.add_argument('cast')
parser.add_argument('out')
parser.add_argument('--start', type=float, default=-1.5)
parser.add_argument('--seconds', type=float, default=17)
parser.add_argument('--fps', type=int, default=12)
parser.add_argument('--size', type=int, default=16, help='font size in pixels')
parser.add_argument('--rows', help='FIRST:LAST screen rows to keep')
args = parser.parse_args()

lines = open(args.cast).read().splitlines()
header = json.loads(lines[0])
events = [json.loads(line) for line in lines[1:]]
typed = next(t for t, kind, data in events if kind == 'm' and data == 'typing')
output = [(t, data) for t, kind, data in events if kind == 'o']


def rgb(color, fallback):
    if color == 'default':
        return fallback
    if color in NAMED:
        return NAMED[color]
    try:
        return tuple(int(color[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return fallback


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


class Player:
    """The screen at any moment of the recording, moving forward only."""

    def __init__(self):
        self.screen = pyte.Screen(header['width'], header['height'])
        self.stream = pyte.Stream(self.screen)
        self.next = 0

    def at(self, t):
        while self.next < len(output) and output[self.next][0] <= t:
            self.stream.feed(output[self.next][1])
            self.next += 1
        return self.screen


def band_rows(screen):
    """The band's first row through the prompt box's last: the prompt box's
    borders around its `❯` line, and the rows drawn just above it."""
    text = screen.display
    for border in range(len(text) - 2):
        if text[border].startswith('─' * 10) and '❯' in text[border + 1] and text[border + 2].startswith('─' * 10):
            first = border - 1
            while first > 0 and not text[first].strip():
                first -= 1
            while first > 0 and text[first - 1].strip():
                first -= 1
            return first, border + 2
    raise SystemExit('No prompt box on screen: give --rows.')


font = ImageFont.truetype(FONT, args.size)
bold = ImageFont.truetype(BOLD, args.size)
ascent, descent = font.getmetrics()
w = round(font.getlength('M'))
h = round(args.size * 1.25)
baseline = (h - ascent - descent) // 2

if args.rows:
    first, last = map(int, args.rows.split(':'))
else:
    first, last = band_rows(Player().at(typed + 5))
columns = header['width']
size = (columns * w + 2 * PADDING, (last - first + 1) * h + 2 * PADDING)


def cell(draw, x, y, char):
    fg = rgb(char.fg, FOREGROUND)
    bg = rgb(char.bg, BACKGROUND)
    if char.reverse:
        fg, bg = bg, fg
    if bg != BACKGROUND:
        draw.rectangle([x, y, x + w - 1, y + h - 1], fill=bg)
    code = ord(char.data[0]) if char.data else 32
    if 0x2581 <= code <= 0x2588:
        # A lower eighths block: a bar, or a peak cap low in its cell.
        draw.rectangle([x, y + h - round(h * (code - 0x2580) / 8), x + w - 1, y + h - 1], fill=fg)
    elif code == 0x2594:
        draw.rectangle([x, y, x + w - 1, y + max(1, round(h / 8)) - 1], fill=fg)
    elif code == 0x2580:
        draw.rectangle([x, y, x + w - 1, y + h // 2 - 1], fill=fg)
    elif code == 0x2500:
        thick = max(1, h // 16)
        middle = y + h // 2 - thick // 2
        draw.rectangle([x, middle, x + w - 1, middle + thick - 1], fill=fg)
    elif code == 0x2591:
        draw.rectangle([x, y, x + w - 1, y + h - 1], fill=mix(bg, fg, 0.25))
    elif 0x2800 <= code <= 0x28FF:
        r = max(1.0, w * 0.13)
        for column, row, bit in DOTS:
            if (code - 0x2800) & bit:
                cx, cy = x + w * (0.3 + 0.4 * column), y + h * (0.125 + 0.25 * row)
                draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fg)
    elif char.data.strip():
        draw.text((x, y + baseline), char.data, font=bold if char.bold else font, fill=fg)


def frame(screen):
    image = Image.new('RGB', size, BACKGROUND)
    draw = ImageDraw.Draw(image)
    for row in range(first, last + 1):
        line = screen.buffer[row]
        for column in range(columns):
            cell(draw, PADDING + column * w, PADDING + (row - first) * h, line[column])
    return image


encode = subprocess.Popen(
    [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{size[0]}x{size[1]}', '-r', str(args.fps), '-i', '-',
        '-vf', 'split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
        '-loop', '0', args.out,
    ],
    stdin=subprocess.PIPE,
)
player = Player()
count = round(args.seconds * args.fps)
for n in range(count):
    encode.stdin.write(frame(player.at(typed + args.start + n / args.fps)).tobytes())
encode.stdin.close()
if encode.wait() != 0:
    raise SystemExit('ffmpeg failed')
print(f'{args.out}: {count} frames, {size[0]}x{size[1]}, rows {first}-{last}')
