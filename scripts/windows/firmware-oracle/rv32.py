"""Bounded RV32IMC interpreter for the firmware color oracle only.
No device, file, system-call or native-code execution is implemented.
Install capstone==5.0.7 in a development Python environment.
"""
from capstone import Cs,CS_ARCH_RISCV,CS_MODE_RISCV32,CS_MODE_RISCVC
from capstone.riscv import RISCV_OP_REG,RISCV_OP_IMM,RISCV_OP_MEM
MASK=0xffffffff
def signed(n):return n-0x100000000 if n&0x80000000 else n
class RV:
 def __init__(self,image):
  self.image=image;self.base=0x13000;self.ram=bytearray(0x20000);self.cache={};self.cs=Cs(CS_ARCH_RISCV,CS_MODE_RISCV32|CS_MODE_RISCVC);self.cs.detail=True
 def read(self,address,size):
  if self.base<=address<=self.base+len(self.image)-size:return int.from_bytes(self.image[address-self.base:address-self.base+size],'little')
  if 0x20000000<=address<=0x20020000-size:return int.from_bytes(self.ram[address-0x20000000:address-0x20000000+size],'little')
  raise ValueError(f'Unmapped read {address:x}')
 def write(self,address,size,value):
  if not 0x20000000<=address<=0x20020000-size:raise ValueError(f'Unmapped write {address:x}')
  self.ram[address-0x20000000:address-0x20000000+size]=(value&((1<<(size*8))-1)).to_bytes(size,'little')
 def call(self,pc,value,max_steps=30000,registers=None,hooks=None):
  pc+=self.base
  r={'sp':0x2001ff00,'ra':0xfffffc,'a0':value,**(registers or {})};steps=0
  get=lambda name:0 if name=='zero' else r.get(name,0)
  while pc!=0xfffffc:
   steps+=1
   if steps>max_steps:raise ValueError('Pure function exceeded instruction budget')
   if hooks and pc in hooks:
    hooks[pc](r);pc=get('ra');continue
   if pc not in self.cache:
    offset=pc-self.base
    if not 0<=offset<len(self.image):raise ValueError(f'Execution outside pinned image: {pc:x}')
    i=next(self.cs.disasm(self.image[offset:offset+4],pc),None)
    if i is None:raise ValueError(f'Undecodable {pc:x}')
    ops=[]
    for o in i.operands:
     if o.type==RISCV_OP_REG:ops.append(i.reg_name(o.reg))
     elif o.type==RISCV_OP_IMM:ops.append(o.imm)
     elif o.type==RISCV_OP_MEM:ops.append((i.reg_name(o.mem.base),o.mem.disp))
     else:raise ValueError('Unknown operand')
    self.cache[pc]=(i.mnemonic,ops,i.size)
   mn,o,size=self.cache[pc];m=mn.removeprefix('c.');nxt=pc+size
   def val(i):return get(o[i]) if isinstance(o[i],str) else o[i]
   def put(v):
    if o[0]!='zero':r[o[0]]=v&MASK
   def mem(i):return ((get(o[i][0])+o[i][1]) if isinstance(o[i],tuple) else (o[i]+get(o[i+1])))&MASK
   if m in ['li','lui']:put(val(1)<<(12 if m=='lui' else 0))
   elif m=='mv':put(val(1))
   elif m=='auipc':put(pc+(val(1)<<12))
   elif m in ['addi','addi16sp','andi','ori','xori','slli','srli','srai','slti','sltiu']:
    a,b=(get(o[0]),val(1)) if len(o)==2 else (val(1),val(2))
    if m.startswith('addi'):v=a+b
    elif m=='andi':v=a&b
    elif m=='ori':v=a|b
    elif m=='xori':v=a^b
    elif m=='slli':v=a<<(b&31)
    elif m=='srli':v=a>>(b&31)
    elif m=='srai':v=signed(a)>>(b&31)
    elif m=='slti':v=int(signed(a)<b)
    else:v=int(a<(b&MASK))
    put(v)
   elif m=='addi4spn':put(val(1)+val(2))
   elif m in ['add','sub','mul','mulh','mulhu','mulhsu','div','divu','rem','remu','and','or','xor','sll','srl','sra','slt','sltu']:
    a,b=(get(o[0]),val(1)) if len(o)==2 else (val(1),val(2))
    if m=='add':v=a+b
    elif m=='sub':v=a-b
    elif m=='mul':v=a*b
    elif m=='mulh':v=(signed(a)*signed(b))>>32
    elif m=='mulhu':v=(a*b)>>32
    elif m=='mulhsu':v=(signed(a)*b)>>32
    elif m in ['div','rem']:
     x,y=signed(a),signed(b);q=(-1 if (x<0)!=(y<0) else 1)*(abs(x)//abs(y)) if y else -1
     v=q if m=='div' else (x-q*y if y else x)
    elif m in ['divu','remu']:v=(a//b if b else MASK) if m=='divu' else (a%b if b else a)
    elif m=='and':v=a&b
    elif m=='or':v=a|b
    elif m=='xor':v=a^b
    elif m=='sll':v=a<<(b&31)
    elif m=='srl':v=a>>(b&31)
    elif m=='sra':v=signed(a)>>(b&31)
    elif m=='slt':v=int(signed(a)<signed(b))
    else:v=int(a<b)
    put(v)
   elif m in ['neg','not','seqz','snez','sltz','sgtz']:
    a=val(1);put(-a if m=='neg' else ~a if m=='not' else int(a==0) if m=='seqz' else int(a!=0) if m=='snez' else int(signed(a)<0) if m=='sltz' else int(signed(a)>0))
   elif m in ['lb','lbu','lh','lhu','lw','lwsp']:
    size_read=1 if m in ['lb','lbu'] else 2 if m in ['lh','lhu'] else 4;v=self.read(mem(1),size_read)
    if m in ['lb','lh'] and v&(1<<(size_read*8-1)):v-=1<<(size_read*8)
    put(v)
   elif m in ['sb','sh','sw','swsp']:self.write(mem(1),{'sb':1,'sh':2}.get(m,4),val(0))
   elif m in ['beq','bne','blt','bge','bltu','bgeu']:
    a,b=val(0),val(1);yes=a==b if m=='beq' else a!=b if m=='bne' else signed(a)<signed(b) if m=='blt' else signed(a)>=signed(b) if m=='bge' else a<b if m=='bltu' else a>=b
    if yes:nxt=pc+val(2)
   elif m in ['beqz','bnez','bgez','bltz','blez','bgtz']:
    a=val(0);yes=a==0 if m=='beqz' else a!=0 if m=='bnez' else signed(a)>=0 if m=='bgez' else signed(a)<0 if m=='bltz' else signed(a)<=0 if m=='blez' else signed(a)>0
    if yes:nxt=pc+val(1)
   elif m in ['j','jal']:
    if m=='jal':r[o[0] if len(o)>1 else 'ra']=nxt
    nxt=pc+val(len(o)-1)
   elif m in ['jr','jalr','ret']:
    target=get('ra') if m=='ret' else val(0) if len(o)==1 else (val(1)+val(2))&MASK
    if m=='jalr':r[o[0] if len(o)>1 else 'ra']=nxt
    nxt=target&~1
   elif m=='nop':pass
   else:raise ValueError(f'Unsupported {mn} {o} at {pc:x}')
   pc=nxt&MASK
  return get('a0')
