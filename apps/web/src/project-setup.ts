import{ProjectSetupViewSchema,waitForProjectSetupViews,type GitBranchChange}from'@jevellan/core/client';
import{api}from'./api.js';
/** Transport binding only; setup readiness, cadence and notifications belong to the engine policy. */
export async function waitForProjectSetup(projectId:string,signal:AbortSignal,waiting:()=>void,branchChanged?:(change:GitBranchChange)=>void,completed?:(change:GitBranchChange)=>void):Promise<void>{
 await waitForProjectSetupViews(signal=>api(`/api/projects/${encodeURIComponent(projectId)}/setup-view`,ProjectSetupViewSchema,'GET',undefined,{signal,waitForHub:true}),signal,{waiting,...(branchChanged?{branchChanged}:{}),...(completed?{completed}:{})});
}
