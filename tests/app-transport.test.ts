import {afterEach,expect,test,vi} from 'vitest';
import {z} from 'zod';
import {api,ApiError,hubWaiting,isCancelled} from '../apps/web/src/api.js';
import {clientId} from '../apps/web/src/client-id.js';
const schema=z.strictObject({schema:z.literal('transport-fixture-v1'),value:z.number()});
const error=(code='hub-unavailable',retryable=true)=>new Response(JSON.stringify({schema:'error-v1',code,message:'The hub is unavailable. Try again when it is connected.',retryable}),{status:503,headers:{'Content-Type':'application/json'}});
afterEach(()=>{hubWaiting.stop();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
test('browser hub wait retries only its declared retryable contract and clears the waiting notice',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValueOnce(error()).mockResolvedValueOnce(new Response(JSON.stringify({schema:'transport-fixture-v1',value:7})));vi.stubGlobal('fetch',fetcher);const pending=api('/simulated',schema,'GET',undefined,{waitForHub:true});await vi.advanceTimersByTimeAsync(0);expect(fetcher).toHaveBeenCalledTimes(1);expect(hubWaiting.snapshot()).toHaveLength(1);await vi.advanceTimersByTimeAsync(1999);expect(fetcher).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);await expect(pending).resolves.toEqual({schema:'transport-fixture-v1',value:7});expect(fetcher).toHaveBeenCalledTimes(2);expect(hubWaiting.snapshot()).toEqual([]);
});
test('browser transport throws other failures and invalid replies instead of retrying',async()=>{
 for(const [waitForHub,code,retryable] of [[false,'hub-unavailable',true],[true,'different',true],[true,'hub-unavailable',false]] as const){const fetcher=vi.fn().mockResolvedValue(error(code,retryable));vi.stubGlobal('fetch',fetcher);await expect(api('/simulated',schema,'GET',undefined,{waitForHub})).rejects.toMatchObject({status:503,code,retryable});expect(fetcher).toHaveBeenCalledTimes(1);}vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}')));await expect(api('/simulated',schema)).rejects.toMatchObject({status:502,message:'Jevellan returned an unexpected response. Reload this page.'});
});
test('browser navigation aborts hub waits and removes their banner without another request',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValue(error());vi.stubGlobal('fetch',fetcher);const pending=api('/simulated',schema,'GET',undefined,{waitForHub:true}).catch(value=>value);await vi.advanceTimersByTimeAsync(0);hubWaiting.stop();expect(isCancelled(await pending)).toBe(true);await vi.advanceTimersByTimeAsync(4000);expect(fetcher).toHaveBeenCalledTimes(1);expect(hubWaiting.snapshot()).toEqual([]);expect(isCancelled(new ApiError('A simulated error.',401))).toBe(false);
});
test('browser request IDs remain random RFC variant version four UUIDs without randomUUID',()=>{
 const ids=new Set(Array.from({length:100},()=>clientId()));expect(ids.size).toBe(100);for(const id of ids)expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});
