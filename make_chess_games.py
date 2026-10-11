"""Regenerate chess records: uv run --with python-chess make_chess_games.py."""
import io
import json
import subprocess
from pathlib import Path

import chess
import chess.pgn

SOURCE = 'https://theweekinchess.com/assets/files/pgn/'
FILES = ['wchcand24.pgn', 'wchwcand24.pgn', 'wch24.pgn']
OUT = Path(__file__).parent / 'static/chess-games.js'


def record(game):
    board, moves = game.board(), []
    if game.errors or board.fen() != chess.STARTING_FEN:
        raise ValueError('Expected a valid standard chess game')
    for move in game.mainline_moves():
        if move not in board.legal_moves:
            raise ValueError(f'Illegal move: {move}')
        capture = move.to_square if board.is_capture(move) else -1
        if board.is_en_passant(move):
            capture = move.to_square + (-8 if board.turn else 8)
        entry = [move.from_square, move.to_square, capture]
        if move.promotion or board.is_castling(move):
            entry.append(chess.piece_name(move.promotion) if move.promotion else None)
        if board.is_castling(move):
            rank = move.from_square // 8 * 8
            entry.extend([rank + (7 if board.is_kingside_castling(move) else 0),
                          rank + (5 if board.is_kingside_castling(move) else 3)])
        moves.append(entry)
        board.push(move)
    if not moves:
        raise ValueError('Expected a game with moves')
    return {key.lower(): game.headers[key] for key in ['Event', 'Date', 'White', 'Black', 'Result']} | {'moves': moves}


def main():
    games = []
    for name in FILES:
        pgn = io.StringIO(subprocess.check_output(['curl', '-fsSL', SOURCE + name]).decode('cp1252'))
        while game := chess.pgn.read_game(pgn):
            if game.end() is not game:
                games.append(record(game))
    OUT.write_text(f'// Professional games from The Week in Chess ({SOURCE}), made by make_chess_games.py.\n'
                   'window.CHESS_GAMES = [\n' + ',\n'.join(json.dumps(g, ensure_ascii=False, separators=(',', ':'))
                                                          for g in games) + '\n];\n')
    print(f'{len(games)} games, {sum(len(g["moves"]) for g in games)} moves')


if __name__ == '__main__':
    main()
