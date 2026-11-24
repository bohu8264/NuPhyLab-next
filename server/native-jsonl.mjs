// Bound bytes before decoding or allocating a complete line, including when a
// child floods stdout without a newline. UTF-8 may be split across chunks.
export function readJsonLines(input,onMessage,onError,{maxLineBytes,validate,invalid}) {
  let pending=Buffer.alloc(0),closed=false;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const fail=error=>{if(!closed){closed=true;pending=Buffer.alloc(0);onError(error);}};
  const data=chunk=>{
    if(closed)return;
    let at=0;
    while(at<chunk.length&&!closed){
      const end=chunk.indexOf(10,at),part=chunk.subarray(at,end<0?chunk.length:end+1);
      if(pending.length+part.length>maxLineBytes){fail(invalid('桥接回复超过 32 KiB 限制'));return;}
      const bytes=pending.length?Buffer.concat([pending,part]):part;
      at+=part.length;
      if(end<0){pending=Buffer.from(bytes);return;}
      pending=Buffer.alloc(0);
      let value;
      try{value=validate(JSON.parse(decoder.decode(bytes)));}
      catch{fail(invalid('桥接回复损坏、编码错误或格式无效'));return;}
      try{onMessage(value);}catch(error){fail(error);}
    }
  };
  const end=()=>{if(pending.length)fail(invalid('桥接回复在消息完成前中断'));};
  const error=()=>fail(invalid('无法读取键盘桥接回复'));
  input.on('data',data);input.on('end',end);input.on('error',error);
  return ()=>{closed=true;pending=Buffer.alloc(0);input.off('data',data);input.off('end',end);input.off('error',error);};
}
