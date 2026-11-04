'use strict';
const zlib=require('zlib');
// Remove only retired local diagnostic keys from old client preferences. No recording.
const KEY='CEM_MAP_TRACE_V2',OLD_KEY='CEM_MAP_TRACE_V1';
function sanitize(data,codec){
 const {document,fields,protobuf,boundedInflate}=codec;let changed=false;
 const parts=document(data).map(row=>{
  if(row.name!=='S1UI_GFxManager')return row.raw;
  const w=fields(row.value),one=n=>{const a=w.filter(v=>v.number===n);if(a.length!==1)throw Error('Unknown GFx wrapper');return a[0];};
  const payload=one(20),compressed=one(30).value,size=one(40).value;
  if(![0,1].includes(compressed)||size>262144)throw Error('Unsupported GFx payload');
  const plain=compressed?boundedInflate(payload.value,size):payload.value;
  if(plain.length!==size)throw Error('GFx size mismatch');
  const kept=[];let rowChanged=false;
  for(const entry of fields(plain)){
   if(entry.number!==2||entry.wire!==2){kept.push(entry.raw);continue;}
   const item=fields(entry.value),key=item.find(v=>v.number===1&&v.wire===2),name=key&&key.value.toString('utf16le');
   if(name!==KEY&&name!==OLD_KEY){kept.push(entry.raw);continue;}
   rowChanged=true;changed=true;
  }
  if(!rowChanged)return row.raw;
  const clean=Buffer.concat(kept),packed=compressed?zlib.deflateSync(clean):clean;
  return protobuf(row.number,Buffer.concat(w.map(f=>f.number===20?protobuf(20,packed):f.number===40?protobuf(40,clean.length,false):f.raw)));
 });
 return{data:changed?Buffer.concat(parts):data,changed};
}
function create(mod,codec){
 const hooks=[];let warned=false;
 function clean(op,buffer){
  try{const result=sanitize(codec.rawData(buffer),codec);if(result.changed)return codec.replaceRaw(buffer,result.data);}
  catch(error){if(!warned){warned=true;mod.warn('Settings Vault: legacy UI cleanup skipped: '+error.message);}}
 }
 for(const name of ['C_SAVE_CLIENT_ACCOUNT_SETTING','S_LOAD_CLIENT_ACCOUNT_SETTING'])
  hooks.push(mod.hook(name,'raw',{order:-11000,filter:{fake:false}},clean));
 return{close(){for(const hook of hooks)mod.unhook(hook);}};
}
module.exports={sanitize,create};
