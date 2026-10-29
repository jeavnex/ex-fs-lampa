import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const directory=process.argv[2], api='https://family-cinema-api.pvde.workers.dev';
const metadata=JSON.parse(readFileSync(join(directory,'version.json'),'utf8'));
const file=join(directory,'FamilyCinema.apk');
if(createHash('sha256').update(readFileSync(file)).digest('hex')!==metadata.sha256)throw Error('Local APK checksum mismatch');
if(!process.env.FAMILY_RELEASE_KEY)throw Error('FAMILY_RELEASE_KEY missing');
async function post(path,body,binary=false){
  for(let attempt=0;attempt<3;attempt++){
    try{
      const response=await fetch(api+path,{method:'POST',headers:{'X-Family-Release-Key':process.env.FAMILY_RELEASE_KEY,'Content-Type':binary?'application/octet-stream':'application/json','User-Agent':'FamilyCinema-Publisher/2.0'},body:binary?body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
      if(!response.ok){const data=await response.json().catch(()=>({}));const error=Error('Publication HTTP '+response.status+' '+(data.error||''));error.retry=response.status>=500;throw error;}
      return await response.json();
    }catch(error){if(attempt===2||error.retry===false)throw error;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}
  }
}
const staged=await post('/api/release/init',metadata);
const handle=openSync(file,'r');
try{let index=0;while(true){const buffer=Buffer.alloc(staged.chunk_size),length=readSync(handle,buffer,0,buffer.length,null);if(!length)break;await post('/api/release/chunk?id='+staged.id+'&index='+index,buffer.subarray(0,length),true);index++;}}
finally{closeSync(handle);}
try{await post('/api/release/commit?id='+staged.id,{});}
catch(error){const current=await (await fetch(api+'/api/version')).json();if(current.sha256!==metadata.sha256)throw error;}
console.log('Published verified APK #'+metadata.version_code+': '+api+'/download/FamilyCinema.apk');
