import json,os,sys
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
base=Path(sys.argv[1])
page="""<!doctype html><meta charset=utf-8><title>NuPhy R54 fixture</title><style>html{font:20px system-ui}body{margin:35px}main{display:grid;gap:18px;width:720px}input,button,a{padding:9px;font-size:18px}#drop{outline:2px dashed #555;padding:45px}footer{height:130vh}</style>
<main><button aria-label="Fixture Click" onclick="emit('click')">Fixture Click</button><label>Fixture Input <input aria-label="Fixture Input" oninput="emit('input',this.value)"></label><a href="#fixture" aria-label="Fixture Link" onclick="emit('link');return false">Fixture Link</a><label><input type=checkbox onchange="emit('checkbox')">Fixture Checkbox</label><a draggable="true" href="/shelf-reference" aria-label="Shelf Source">Shelf Source</a><button id=drop aria-label="Fixture Drop Target">Fixture Drop Target</button></main><footer></footer>
<script>function emit(k,v=''){fetch('/event',{method:'POST',body:JSON.stringify({k,v})})}const d=document.querySelector('#drop');d.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'});d.addEventListener('drop',e=>{e.preventDefault();emit('drop',Array.from(e.dataTransfer.files).map(x=>x.name));});document.addEventListener('contextmenu',e=>{if(e.target.tagName==='BUTTON'){e.preventDefault();emit('right')}});document.addEventListener('dblclick',e=>{if(e.target.tagName==='BUTTON')emit('double')});document.querySelector('button').addEventListener('mouseenter',()=>emit('hover'));window.addEventListener('scroll',()=>emit('scroll',scrollY));function sourcePoint(){
 if(!document.hasFocus() || document.hidden)return;
 const a=document.querySelector('a[aria-label="Shelf Source"]'),r=document.createRange();r.selectNodeContents(a);
 const rect=r.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;
 if(document.elementFromPoint(x,y)?.closest('a')!==a)return;
 const border=(outerWidth-innerWidth)/2;
 emit('source-point',[screenX+border+x,screenY+outerHeight-innerHeight-border+y]);
}
addEventListener('focus',sourcePoint);addEventListener('resize',sourcePoint);addEventListener('load',sourcePoint);
setInterval(sourcePoint,450);
</script>"""
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  payload=page.encode();self.send_response(200);self.send_header('Content-type','text/html; charset=utf-8');self.send_header('Content-length',len(payload));self.end_headers();self.wfile.write(payload)
 def do_POST(self):
  if self.path!='/event':self.send_error(404);return
  n=min(int(self.headers.get('Content-Length','0')),2048)
  try:
   e=json.loads(self.rfile.read(n));assert e.get('k') in {'click','input','link','checkbox','right','double','hover','scroll','drop','source-point'}
   with (base/'browser-events').open('a') as f:f.write(json.dumps(e)+'\n')
  except Exception:pass
  self.send_response(204);self.end_headers()
 def log_message(self,*a): pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);(base/'webport').write_text(str(server.server_port));server.serve_forever()
