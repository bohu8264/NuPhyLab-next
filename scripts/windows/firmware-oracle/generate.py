"""Reproduce facts from two pinned images; never flash a keyboard.
Usage: python generate.py <1.0.23.6.bin> <2.0.0.7.bin> [--write]
"""
from pathlib import Path
import hashlib,itertools,json,random,struct,sys
from rv32 import RV

ROOT=Path(__file__).resolve().parents[3]
OLD_SHA='d2b39152a6bd02804044e9fef2bc400b9cfa7b7b7156bae048f76bf6c4fd4a66'
NEW_SHA='619685122bb1882ceaa032a902c32883774639eccc9b86402ea8f0e195c3f610'
def load(file,digest):
    data=Path(file).read_bytes()
    if hashlib.sha256(data).hexdigest()!=digest:raise ValueError('Firmware hash mismatch; review the image before changing the pin')
    return data
def render(engine,rgb,hsv_pc,rgb_pc):
    # Firmware structs use GRB ordering; public protocol and oracle use RGB.
    packed=int.from_bytes(bytes([rgb[1],rgb[0],rgb[2]]),'little')
    hsv=engine.call(hsv_pc,packed);out=engine.call(rgb_pc,hsv).to_bytes(4,'little')
    return [out[1],out[0],out[2]]
def generate(old,new):
    a,b=RV(old),RV(new)
    swift=json.loads((ROOT/'tests/fixtures/windows-lighting-recovery.json').read_text())
    colors=[]
    for rgb,expected,_ in swift['colors']:
        assert render(a,rgb,0x4d92,0x4f16)==expected,'Interpreter disagrees with the established Swift oracle'
        colors.append([rgb,render(b,rgb,0x7052,0x71d6)])
    randomizer=random.Random(2007)
    for _ in range(4096):
        rgb=[randomizer.randrange(256) for _ in range(3)]
        colors.append([rgb,render(b,rgb,0x7052,0x71d6)])
    # Exercise every hue half-step at both exceptional delta values, with
    # low/mid/high brightness boundaries and all channel orderings.
    inputs=set()
    for delta in [86,172]:
        for lower in [0,1,255-delta]:
            for middle in range(lower,lower+delta+1):inputs.update(itertools.permutations([lower,middle,lower+delta]))
    boundaries=[[list(rgb),render(b,rgb,0x7052,0x71d6)] for rgb in sorted(inputs)]
    # Run the actual renderer; replace only its final hardware LED callback
    # with an in-memory recorder. All masks, arithmetic and buffer indexing
    # still execute from the pinned image. No peripheral code is interpreted.
    gp=0x20008000;palette=gp+0x4bc;argument=0x20014000
    led=struct.unpack_from('<I',new,0x55644)[0];palettes=[]
    for value in range(256):
        rgb=[value,255-value,value];grb=[rgb[1],rgb[0],rgb[2]]
        for index in range(84):
            for channel in range(3):b.write(palette+index*3+channel,1,grb[channel])
        b.write(gp-0x665,1,200);observed={}
        def record(registers):
            index=registers['a0'];assert 0<=index<84 and index not in observed
            observed[index]=[registers.get(f'a{i}',0)&255 for i in [1,2,3]]
        for chunk in range(4):
            b.write(argument,1,chunk);b.write(argument+1,1,255)
            b.call(0xbfe4,argument,registers={'gp':gp},hooks={led:record})
        assert len(observed)==84
        assert all(observed[i]==observed[0] for i in range(83))
        palettes.append([rgb,observed[0],observed[83]])
    routes=[]
    for group,old_base,new_base,count,offset in [('main',0x44408,0x5684c,7,0),('side',0x44424,0x56868,6,9),('preset',0x4443c,0x56880,5,17)]:
        for i in range(count):
            x=(old_base+struct.unpack_from('<i',old,old_base+4*i)[0])&0xffffffff
            y=(new_base+struct.unpack_from('<i',new,new_base+4*i)[0])&0xffffffff
            assert x-0x151b4==y-0x19790,'Settings case routing changed'
            routes.append({'field':offset+i,'group':group,'oldTarget':x,'newTarget':y})
    assert [r['field'] for r in routes if r['newTarget']==0x19870]==[5,13]
    return {'schema':1,'modelId':'air75-v3','firmwareVersion':'2.0.0.7',
        'source':{'loadAddress':77824,'oldUrl':'https://cdn.nuphy.io/image/2026/10/15/d12ab108a72c4328a1c51f49e6a200b3.zip','oldImageSha256':OLD_SHA,
          'newUrl':'https://air75-v3-ansi-beta-firmware-v2007.netlify.app/','newImageSha256':NEW_SHA,
          'method':'Bounded RV32IMC execution of pure color functions; old image independently matched against 4096 Swift vectors; no HID or firmware update',
          'scope':'Color and settings-routing evidence only. Physical restoration still requires independent device readback.'},
        'colors':colors,'boundaries':boundaries,'palettes':palettes,'routes':routes}
if __name__=='__main__':
    if len(sys.argv) not in [3,4] or len(sys.argv)==4 and sys.argv[3]!='--write':raise SystemExit(__doc__)
    result=generate(load(sys.argv[1],OLD_SHA),load(sys.argv[2],NEW_SHA))
    target=ROOT/'tests/fixtures/air75-v3-2.0.0.7-lighting.json'
    if len(sys.argv)==4:
        header=json.dumps({k:v for k,v in result.items() if k not in ['colors','boundaries','palettes','routes']},ensure_ascii=False,indent=2)[:-2]
        target.write_text(header+',\n  "colors": [\n'+',\n'.join('    '+json.dumps(v,separators=(',',':')) for v in result['colors'])+'\n  ],\n  "boundaries": [\n'+',\n'.join('    '+json.dumps(v,separators=(',',':')) for v in result['boundaries'])+'\n  ],\n  "palettes": '+json.dumps(result['palettes'],separators=(',',':'))+',\n  "routes": '+json.dumps(result['routes'],separators=(',',':'))+'\n}\n')
    else:assert json.loads(target.read_text())==result,'Committed oracle differs from the pinned firmware images'
    print(f"Verified {len(result['colors'])} colors, {len(result['boundaries'])} hue boundaries, {len(result['palettes'])} full palette renders and {len(result['routes'])} settings routes; no HID opened")
