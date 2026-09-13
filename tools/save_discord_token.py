"""Human-only hidden terminal input; validate a new Bot binding and save privately."""
from __future__ import annotations
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

parser=argparse.ArgumentParser()
parser.add_argument('--app',required=True)
parser.add_argument('--output',default='.kotodama/secrets/discord.env')
parser.add_argument('--replace',action='store_true')
args=parser.parse_args()
if not re.fullmatch(r'\d{5,24}',args.app):raise SystemExit('Application IDを確認してください。')
if not sys.stdin.isatty():raise SystemExit('本人が操作するターミナルで実行してください。Tokenをチャットや引数へ送らないでください。')
root=Path.cwd().resolve();target=Path(args.output).absolute()
if not target.resolve().is_relative_to(root):raise SystemExit('保存先は現在のworkspace内にしてください。')
for p in [target,*target.parents]:
    if p==root.parent:break
    if p.is_symlink():raise SystemExit('リンクへの保存はできません。')
if target.exists() and not args.replace:raise SystemExit('保存先が存在します。上書きが必要な場合だけ --replace を指定してください。')
token=getpass.getpass('新しいBot token（表示しません）: ').strip()
if not token or '\n' in token or '\r' in token:raise SystemExit('Tokenが空、または形式が不正です。')
request=urllib.request.Request('https://discord.com/api/v10/oauth2/applications/@me',headers={'Authorization':'Bot '+token,'User-Agent':'KotodamaTokenSetup/1.0'},method='GET')
try:
    with urllib.request.urlopen(request,timeout=15) as response:app=json.load(response)
except Exception:raise SystemExit('Botの確認に失敗しました。Token値は保存していません。')
if app.get('id')!=args.app:raise SystemExit('指定した新しいApplicationのTokenではありません。保存していません。')
target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
fd=os.open(target,os.O_WRONLY|os.O_CREAT|(os.O_TRUNC if args.replace else os.O_EXCL),0o600)
with os.fdopen(fd,'w',encoding='utf-8') as out:out.write('DISCORD_BOT_TOKEN='+token+'\n')
token=''
print(json.dumps({'saved':True,'applicationId':app['id'],'path':str(target.relative_to(root)),'secretPrinted':False},ensure_ascii=False))
