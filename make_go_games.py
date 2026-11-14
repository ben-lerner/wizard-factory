"""Regenerate static/go-games.js from the NHK Cup games in Andries Brouwer's database.

Run with python3 make_go_games.py. Handicap games are skipped; COUNT games are sampled evenly.
"""
import io
import json
import re
import tarfile
import tempfile
import urllib.request
from pathlib import Path

SOURCE = 'https://homepages.cwi.nl/~aeb/go/games/'
OUT = Path(__file__).parent / 'static/go-games.js'
COUNT = 100
TOKEN = re.compile(r'\s*(\(|\)|;|([A-Z]+)((?:\[(?:\\.|[^\]\\])*\]\s*)+))', re.S)


def main_line(text):
    # Following the first child at every fork, the main line ends at the first ')'.
    nodes = []
    for m in TOKEN.finditer(text):
        if m.group(1) == ')':
            return nodes
        if m.group(1) == ';':
            nodes.append({})
        elif m.group(2) and nodes:
            nodes[-1][m.group(2)] = re.findall(r'\[((?:\\.|[^\]\\])*)\]', m.group(3))
    return nodes


def point(v):
    return [ord(v[0]) - 97, ord(v[1]) - 97] if len(v) == 2 and max(v) <= 's' else [-1, -1]


def game(nodes):
    get = lambda key: nodes[0].get(key, [''])[0].strip()
    player = lambda c: ' & '.join(n.split(',')[0].strip() for n in get('P' + c).split('&'))
    return {'event': get('EV'), 'date': get('DT')[:10], 'black': player('B'), 'white': player('W'),
            'result': get('RE'), 'moves': [[*point(n[c][0]), side] for n in nodes for side, c in enumerate('BW') if c in n]}


def main():
    with tempfile.TemporaryDirectory() as directory, urllib.request.urlopen(SOURCE + 'games.tgz') as response:
        tar = tarfile.open(fileobj=io.BytesIO(response.read()))
        tar.extractall(directory, [m for m in tar if m.name.startswith('games/NHK/')], filter='data')
        records = [main_line(path.read_text(errors='replace')) for path in sorted(Path(directory).rglob('*.sgf'))]
    games = [game(nodes) for nodes in records
             if nodes and nodes[0].get('SZ', ['19'])[0] == '19' and not {'HA', 'AB'} & nodes[0].keys()]
    games = games[::-(-len(games) // COUNT)]
    OUT.write_text(f'// NHK Cup games from {SOURCE} (public domain), made by make_go_games.py.\n'
                   'window.GO_GAMES = [\n' + ',\n'.join(json.dumps(g, ensure_ascii=False, separators=(',', ':'))
                                                       for g in games) + '\n];\n')
    print(f'{len(games)} games, {sum(len(g["moves"]) for g in games)} moves')


if __name__ == '__main__':
    main()
