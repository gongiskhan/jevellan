import {JevLessonInputSchema,type JevLesson,type JevLessonInput} from '@jevellan/core';
/** Explicit scope and creation order only; lesson meaning is Jev's decision. */
export function scopedJevLessons(projectId:string,rows:readonly JevLesson[]=[]){return rows.filter(row=>row.enabled&&(row.scope==='global'||row.projectId===projectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||Number(b.id.slice(1))-Number(a.id.slice(1)));}
export function projectJevLessons(projectId:string,rows:readonly JevLesson[]=[]){
 const scoped=scopedJevLessons(projectId,rows),selected=scoped.slice(0,30),corrections=scoped.filter(row=>row.about==='landing').slice(0,8),used=[...new Map([...selected,...corrections].map(row=>[row.key,row])).values()];
 const input:JevLessonInput|undefined=selected.length?JevLessonInputSchema.parse({schema:'jev-lesson-input-v1',heading:"Lessons from the owner's overrides",items:selected.map(({id,key,text})=>({id,key,text}))}):undefined;
 return{input,corrections,ids:used.map(row=>row.id),keys:used.map(row=>row.key)};
}
