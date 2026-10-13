import {buildConformance,implementations,ROOT} from '/Users/leostera/Developer/github.com/leostera/poneglyph/tests/conformance/build.ts';
import {startHosted} from '/Users/leostera/Developer/github.com/leostera/poneglyph/tests/conformance/process-runtime.ts';
import {Session} from '/Users/leostera/Developer/github.com/leostera/poneglyph/tests/conformance/session.ts';
import {smallCases,checkAllLookups} from '/Users/leostera/Developer/github.com/leostera/poneglyph/tests/conformance/small.ts';
import {auditAuthorities} from '/Users/leostera/Developer/github.com/leostera/poneglyph/tests/conformance/authority-audit.ts';
import {errorEvidence} from '/Users/leostera/Developer/github.com/leostera/poneglyph/tests/conformance/response-evidence.ts';
import {resolve} from 'node:path';import{mkdir,writeFile}from'node:fs/promises';import{appendFileSync}from'node:fs';import{channel}from'node:diagnostics_channel';import{Socket}from'node:net';
const id='focused-E-transport-'+new Date().toISOString().replaceAll(':','-'),out=resolve(ROOT,'results',id),art=resolve(ROOT,'.artifacts',id);await mkdir(out,{recursive:true});
for(const name of ['undici:client:beforeConnect','undici:client:connected','undici:client:connectError','undici:client:sendHeaders','undici:request:error'])channel(name).subscribe(input=>{
 if(input===null||typeof input!=='object')return;const request=Reflect.get(input,'request'),socket=Reflect.get(input,'socket'),error=Reflect.get(input,'error');
 const entry={event:name,recordedAt:new Date().toISOString(),path:request&&typeof request==='object'?Reflect.get(request,'path'):undefined,
 socket:socket instanceof Socket?{localPort:socket.localPort,remotePort:socket.remotePort,destroyed:socket.destroyed,bytesRead:socket.bytesRead,bytesWritten:socket.bytesWritten}:undefined,
 error:error?errorEvidence(error):undefined};appendFileSync(resolve(out,'transport.jsonl'),JSON.stringify(entry)+'\n');
});
const impl=implementations.find(x=>x.name==='E');if(!impl)throw Error('missing E');const bundles=resolve(art,'bundles'),persistence=resolve(art,'persistence'),manifest=await buildConformance(impl,bundles);
const report={kind:'focused-conformance-transport-diagnostic',id,manifest,persistence,plannedCases:smallCases.map(x=>x.name),results:[],status:'running',error:undefined};
const save=()=>writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');await save();const runtime=await startHosted('conformance',persistence,bundles);let session;
try{for(const[index,test]of smallCases.entries()){session=new Session(runtime,`conformance-small-${index}`);const result={name:test.name,status:'running',outcomes:session.outcomes};report.results.push(result);await save();try{await test.run(session);for(const s of[session,...session.related])await auditAuthorities(s);await checkAllLookups(session);await session.verify();result.status='pass';}catch(error){result.status='fail';throw error;}finally{await save();}console.log('E focused-pass',test.name);}report.status='complete';}
catch(error){report.status='stopped';report.error=errorEvidence(error);process.exitCode=1;console.error(error);}
finally{if(session&&report.status==='stopped')for(const s of[session,...session.related])await s.drain();await runtime.close();await save();console.log(out);}
