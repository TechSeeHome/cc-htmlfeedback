# POC-4: the documented agent recipe, run as home-knowledge@techsee.me using
# ONLY design.md §5 contracts (Sheets values + Drive files REST).
#
#   python3 agent-path.py negative   # expect: read OK (drive Viewer), write 403
#   python3 agent-path.py positive   # expect: reply appended + status updated
#
# Token: .secrets/token-agent.json (minted in P3, gitignored).

import json
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
import uuid
import datetime
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = os.path.join(HERE, '.secrets', 'token-agent.json')
COMMENTS_SHEET = '1dT1HD7K8bLt0AofnG9n_PkU50MkdT1Jk8aYcK3x9F0c'  # design.html.comments
DOC_FILE = '1acs8dWa-irv4c86CFTw2Cyj916qOAti4'                    # design.html

TICKET_COLS = ['id', 'parentId', 'type', 'status', 'quote', 'context', 'section',
               'note', 'authorEmail', 'authorName', 'source', 'docVersion',
               'result', 'files', 'createdAt', 'updatedAt']


def mint(tokfile):
    t = json.load(open(tokfile))
    data = urllib.parse.urlencode({
        'client_id': t['client_id'], 'client_secret': t['client_secret'],
        'refresh_token': t['refresh_token'], 'grant_type': 'refresh_token'}).encode()
    return json.load(urllib.request.urlopen(urllib.request.Request(
        'https://oauth2.googleapis.com/token', data=data)))['access_token']


def call(at, url, method='GET', payload=None):
    req = urllib.request.Request(
        url, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': 'Bearer ' + at,
                 **({'Content-Type': 'application/json'} if payload is not None else {})})
    return json.load(urllib.request.urlopen(req))


at = mint(TOKEN)
me = call(at, 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)')['user']['emailAddress']
assert me == 'home-knowledge@techsee.me', f'wrong identity: {me}'
print(f'[identity] {me}')

# --- read side (works at Viewer level already) ---
rows = call(at, f'https://sheets.googleapis.com/v4/spreadsheets/{COMMENTS_SHEET}/values/tickets!A2:P').get('values', [])
open_tickets = [r for r in rows if len(r) > 3 and r[3] == 'open']
print(f'[read] {len(rows)} tickets, {len(open_tickets)} open')
head = call(at, f'https://www.googleapis.com/drive/v3/files/{DOC_FILE}?alt=media&supportsAllDrives=true'
            if False else f'https://www.googleapis.com/drive/v3/files/{DOC_FILE}?supportsAllDrives=true&fields=name,size')
print(f'[read] doc metadata: {head}')

if not open_tickets:
    sys.exit('no open ticket to act on - seed one first')
parent = open_tickets[0]
parent_row_idx = rows.index(parent) + 2  # 1-based + header
print(f'[target] open ticket {parent[0][:8]} (sheet row {parent_row_idx})')

mode = sys.argv[1] if len(sys.argv) > 1 else 'negative'
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
reply = [str(uuid.uuid4()), parent[0], 'reply', 'open', '', '', '',
         'poc4: agent reply via Sheets REST (documented contract only)',
         me, '', 'agent', '', '', '', now, now]

t0 = time.time()
try:
    call(at, f'https://sheets.googleapis.com/v4/spreadsheets/{COMMENTS_SHEET}/values/'
             f'tickets!A:P:append?valueInputOption=RAW', 'POST', {'values': [reply]})
    print(f'[write] reply APPENDED in {time.time() - t0:.1f}s (id {reply[0][:8]})')
    parent[3] = 'in-progress'
    parent[TICKET_COLS.index('updatedAt')] = now
    call(at, f'https://sheets.googleapis.com/v4/spreadsheets/{COMMENTS_SHEET}/values/'
             f'tickets!A{parent_row_idx}:P{parent_row_idx}?valueInputOption=RAW', 'PUT',
         {'values': [parent + [''] * (16 - len(parent))]})
    print(f'[write] parent {parent[0][:8]} status -> in-progress')
    if mode == 'negative':
        print('RESULT: UNEXPECTED - writes succeeded in negative mode')
    else:
        print('RESULT: POSITIVE PASS')
except urllib.error.HTTPError as e:
    print(f'[write] DENIED: HTTP {e.code}')
    print('RESULT: NEGATIVE PASS' if mode == 'negative' else 'RESULT: POSITIVE FAIL - still denied')
