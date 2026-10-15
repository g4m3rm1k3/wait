import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const folder=dirname(fileURLToPath(import.meta.url));
const url='http://127.0.0.1:4173';
function ready(){return new Promise(resolve=>{const request=http.get(url,response=>{response.resume();resolve(response.statusCode===200);});request.on('error',()=>resolve(false));request.setTimeout(500,()=>{request.destroy();resolve(false);});});}
if(!await ready()){
  const server=spawn(process.execPath,[join(folder,'server.js')],{cwd:folder,detached:true,windowsHide:true,stdio:'ignore'});server.unref();
  for(let attempt=0;attempt<30;attempt++){if(await ready())break;await new Promise(resolve=>setTimeout(resolve,200));}
}
if(await ready()){
  const command=process.platform==='win32'?'cmd.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=process.platform==='win32'?['/c','start','',url]:[url];
  const browser=spawn(command,args,{detached:true,windowsHide:true,stdio:'ignore'});browser.unref();console.log(`Spindle Sync: ${url}`);
}else{console.error('Could not start Spindle Sync. Run npm start in this folder to see the error.');process.exitCode=1;}
