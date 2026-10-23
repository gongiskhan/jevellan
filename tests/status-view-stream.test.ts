import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as core from '../packages/core/dist/index.js';
import { streamLedger } from '../apps/daemon/dist/conversation-events.js';

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }
afterEach(()=>vi.restoreAllMocks());

test('the shared refresh policy retains completed reads and serializes every catch-up', async()=>{
 const shared=Reflect.get(core,'queuedRefresh'); expect(shared).toBeTypeOf('function');
 const first=deferred<string>(), second=deferred<string>(), receive=vi.fn(), failed=vi.fn();
 const read=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
 const refresh=shared(read,receive,failed); const pending=refresh.request(); await refresh.request(); await refresh.request();
 expect(read).toHaveBeenCalledOnce(); first.resolve('first'); await Promise.resolve(); expect(receive.mock.calls).toEqual([['first']]); expect(read).toHaveBeenCalledTimes(2);
 refresh.stop(); second.resolve('late'); await pending; expect(receive.mock.calls).toEqual([['first']]); expect(failed).not.toHaveBeenCalled();
});

test('status views are coalesced after raw ledger events without overlapping reads or sending after close',async()=>{
 const events=[{id:1}]; let wake=()=>{};let unsubscribed=false;
 const ledger={lastId:()=>events.at(-1)?.id??0,events:(after=0,limit=Number.MAX_SAFE_INTEGER)=>events.filter(e=>e.id>after).slice(0,limit),subscribe:(next:()=>void)=>{wake=next;return()=>{unsubscribed=true;};}};
 const writes:string[]=[];const response=Object.assign(new EventEmitter(),{write:(s:string)=>{writes.push(s);return true;},writeHead:()=>{},flushHeaders:()=>{},end:()=>{},destroy:()=>{}}) as unknown as ServerResponse;
 const first=deferred<unknown>(),second=deferred<unknown>();const read=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
 Reflect.apply(streamLedger,undefined,[ledger,{headers:{}} as IncomingMessage,response,new URL('http://fixture.invalid/'),()=>true,{name:'project',payload:(e:{id:number})=>e,invalidCursor:'Invalid',aheadCursor:'Ahead'},{read}]);
 try {
  await vi.waitFor(()=>expect(writes).toHaveLength(1));expect(read).not.toHaveBeenCalled();
  events.push({id:2});wake();await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());events.push({id:3},{id:4});wake();wake();expect(read).toHaveBeenCalledOnce();
  first.resolve({schema:'fixture-status-v1',value:'first'});await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(2));
  expect(writes).toContain('event: status-view\ndata: {"schema":"fixture-status-v1","value":"first"}\n\n');
  expect(writes.filter(s=>s.startsWith('id:')).map(s=>Number(/^id: (\d+)/.exec(s)![1]))).toEqual([1,2,3,4]);
  response.emit('close');second.resolve({schema:'fixture-status-v1',value:'late'});await new Promise<void>(done=>setImmediate(done));expect(writes.join('')).not.toContain('late');expect(unsubscribed).toBe(true);
 } finally {response.emit('close');}
});


test('a status read failure preserves the ledger stream and late authentication revocation suppresses the snapshot',async()=>{
 const events=[{id:1}];let wake=()=>{};let allowed=true;let ended=false;let destroyed=false;
 const ledger={lastId:()=>events.at(-1)?.id??0,events:(after=0,limit=Number.MAX_SAFE_INTEGER)=>events.filter(e=>e.id>after).slice(0,limit),subscribe:(next:()=>void)=>{wake=next;return()=>{};}};
 const writes:string[]=[];const response=Object.assign(new EventEmitter(),{write:(s:string)=>{writes.push(s);return true;},writeHead:()=>{},flushHeaders:()=>{},end:()=>{ended=true;},destroy:()=>{destroyed=true;}}) as unknown as ServerResponse;
 const pending=deferred<unknown>();const read=vi.fn().mockRejectedValueOnce(new Error('Temporary view failure')).mockReturnValueOnce(pending.promise);
 Reflect.apply(streamLedger,undefined,[ledger,{headers:{}} as IncomingMessage,response,new URL('http://fixture.invalid/'),()=>allowed,{name:'conversation',payload:(e:{id:number})=>e,invalidCursor:'Invalid',aheadCursor:'Ahead'},{read}]);
 try {
  await vi.waitFor(()=>expect(writes).toHaveLength(1));events.push({id:2});wake();await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
  await new Promise<void>(done=>setImmediate(done));expect(destroyed).toBe(false);expect(ended).toBe(false);expect(writes.join('')).toContain('id: 2');
  events.push({id:3});wake();await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(2));allowed=false;pending.resolve({schema:'fixture-status-v1',value:'revoked'});
  await vi.waitFor(()=>expect(ended).toBe(true));expect(writes.join('')).not.toContain('revoked');
 }finally{response.emit('close');}
});

test('project status stream request and receipt binding keep viewer context strict',()=>{
 const schema=Reflect.get(core,'ProjectStatusStreamRequestSchema');expect(schema).toBeTruthy();
 const request={schema:'project-status-stream-request-v1',page:{schema:'project-page-request-v1' as const,resolvedDays:28,timeZone:'UTC',locale:'en',ackKnown:['known']}};
 expect(schema.parse(request)).toEqual(request);expect(()=>schema.parse({...request,extra:true})).toThrow();expect(()=>schema.parse({...request,page:{...request.page,extra:true}})).toThrow();
 const accepts=Reflect.get(core,'matchingProjectStatusView');expect(accepts).toBeTypeOf('function');
 const frame={request:request.page};expect(accepts(frame,request.page)).toBe(true);expect(accepts(frame,{...request.page,resolvedDays:14})).toBe(false);expect(accepts(frame,{...request.page,ackKnown:[]})).toBe(false);expect(accepts(frame,{...request.page,timeZone:'Europe/Lisbon'})).toBe(false);
});

test('a pushed snapshot supersedes an older in-flight fallback without suppressing the next fresh read',async()=>{
 const shared=Reflect.get(core,'queuedRefresh'), first=deferred<string>(), receive=vi.fn();
 const read=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('fresh fallback');
 const refresh=shared(read,receive,vi.fn());expect(refresh.push).toBeTypeOf('function');
 const pending=refresh.request();refresh.push('newer pushed snapshot');first.resolve('older fallback');await pending;
 expect(receive.mock.calls).toEqual([['newer pushed snapshot']]);await refresh.request();expect(receive.mock.calls).toEqual([['newer pushed snapshot'],['fresh fallback']]);
 refresh.stop();refresh.push('after navigation');expect(receive).toHaveBeenCalledTimes(2);
});

test('a burst of ledger notifications shares one forty-millisecond status window while raw events keep flowing',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 const events=[{id:1}];let wake=()=>{};const writes:string[]=[];
 const ledger={lastId:()=>events.at(-1)?.id??0,events:(after=0,limit=Number.MAX_SAFE_INTEGER)=>events.filter(e=>e.id>after).slice(0,limit),subscribe:(next:()=>void)=>{wake=next;return()=>{};}};
 const response=Object.assign(new EventEmitter(),{write:(s:string)=>{writes.push(s);return true;},writeHead:()=>{},flushHeaders:()=>{},end:()=>{},destroy:()=>{}}) as unknown as ServerResponse;
 const read=vi.fn().mockResolvedValue({schema:'fixture-status-v1',value:'latest'});const flush=async()=>{await new Promise<void>(done=>setImmediate(done));await new Promise<void>(done=>setImmediate(done));};
 Reflect.apply(streamLedger,undefined,[ledger,{headers:{}} as IncomingMessage,response,new URL('http://fixture.invalid/'),()=>true,{name:'project',payload:(e:{id:number})=>e,invalidCursor:'Invalid',aheadCursor:'Ahead'},{read}]);
 try{
  await flush();for(let id=2;id<=17;id++){events.push({id});wake();await flush();}
  expect(writes.filter(s=>s.startsWith('id:'))).toHaveLength(17);expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(40);await flush();expect(read).toHaveBeenCalledOnce();expect(writes.filter(s=>s.startsWith('event: status-view'))).toHaveLength(1);
  events.push({id:18});wake();await flush();response.emit('close');await vi.advanceTimersByTimeAsync(100);expect(read).toHaveBeenCalledOnce();
 }finally{response.emit('close');vi.useRealTimers();}
});
