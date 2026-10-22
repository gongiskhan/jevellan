import type {JevReplayCost,ModelPriceTable,ThreadUsageTotal} from '@jevellan/core';
const unavailable=(reason:string):JevReplayCost=>({status:'unavailable',reason,oldUsd:null,newUsd:null,deltaUsd:null});
/** An estimate at unchanged recorded run-token counts, never the usage of the Jev call deciding placement. */
export function estimateReplayCost(usage:ThreadUsageTotal|undefined,oldModelId:string|undefined,newModelId:string|undefined,prices:ModelPriceTable|undefined):JevReplayCost{
  if(oldModelId&&oldModelId===newModelId)return{status:'not-needed',reason:'No model change to estimate.',oldUsd:null,newUsd:null,deltaUsd:0};
  if(!oldModelId||!newModelId)return unavailable('No comparable pair of run models is available.');
  if(!prices)return unavailable('No versioned model price table is configured.');
  if(!usage||usage.turns<1||usage.inputTokens+usage.outputTokens+usage.cacheReadTokens+usage.cacheWriteTokens===0&&usage.costUnknownTurns>0)return unavailable('Verified recorded run usage is unavailable.');
  const before=prices.entries.find(row=>row.modelId===oldModelId),after=prices.entries.find(row=>row.modelId===newModelId);
  if(!before||!after)return unavailable('This price table lacks a rate for one of the run models.');
  if(usage.cacheReadTokens||usage.cacheWriteTokens)return unavailable('This price-table version has no cache-token rates or normalization proof.');
  const total=(price:typeof before)=>(usage.inputTokens*price.inputUsdPerMillion+usage.outputTokens*price.outputUsdPerMillion)/1_000_000,oldUsd=total(before),newUsd=total(after),deltaUsd=newUsd-oldUsd;
  if(![oldUsd,newUsd,deltaUsd].every(Number.isFinite))return unavailable('The token estimate exceeds the numeric budget.');
  return{status:'estimated',reason:'Token estimate from recorded run usage and current versioned prices; unchanged token counts are assumed.',oldUsd,newUsd,deltaUsd};
}
