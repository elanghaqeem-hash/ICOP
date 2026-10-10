/** Phase 6 source-derived grounded tender keyword extraction.
 * No vector/provider integration in 6B1; no conclusion without source text. */
import { norm } from '../modules/tenders/extract.js';

const STOP=new Set(['yang','dan','apa','untuk','dengan','dari','ini','itu','ada','adalah','pada','ke','di','atau','berapa','bagaimana','kapan','apakah','yang','harus','syarat','syaratnya','dokumen','tender','the','and','what','from','this','will','where']);
export function tenderTerms(text:string):string[]{
 return [...new Set(norm(text).split(' ').filter(t=>t.length>=3&&!STOP.has(t)))].slice(0,12);
}
export function tenderTermScore(text:string,terms:string[]):number{
 const n=' '+norm(text)+' ';
 let total=0;
 for(const t of terms){const c=n.split(' '+t+' ').length-1||(n.includes(t)?0.5:0);if(c)total+=1+Math.min(c,5)*0.2;}
 return total;
}
export function tenderExcerpt(text:string,terms:string[],size=500):string{
 const lower=norm(text),pos=terms.map(t=>lower.indexOf(t)).filter(i=>i>=0).sort((a,b)=>a-b)[0]??0;
 // A compact excerpt, never return full RKS documents to the browser.
 const start=Math.max(0,pos-Math.floor(size/3));
 return (start>0?'…':'')+text.slice(start,start+size).trim()+(start+size<text.length?'…':'');
}
export interface SourceExcerpt { id:string; kind:'TENDER'|'RKS'|'REQUIREMENT'|'AANWIJZING';title:string;ref:string;excerpt:string;score:number;sourceId:string|null; }
export function rankTenderSources(candidates:SourceExcerpt[],limit=8):SourceExcerpt[]{
 return candidates.filter(c=>c.score>0).sort((a,b)=>b.score-a.score).slice(0,limit);
}
