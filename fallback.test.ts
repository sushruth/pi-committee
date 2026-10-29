import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
// Execute the production function bodies, not a reimplementation of selection.
const src=readFileSync(new URL('./committee.ts',import.meta.url),'utf8');
const start=src.indexOf('  let forcedFor = "";');
const end=src.indexOf('\n  const afterRound =',start);
const body=src.slice(start,end).replace('(ctx: ExtensionContext, state: RoundState): boolean','(ctx, state)');
function harness(free:any[],focus?:Set<string>){
 const calls:any[]=[];const notices:any[]=[];
 const make=new Function('freeSeats','dispatch','publish','lastHumanId',new Bun.Transpiler({loader:"ts"}).transformSync(`${body}\nreturn {forceAnswer, answeredHumans};`));
 const h=make(()=>free,(...args:any[])=>calls.push(args),()=>{},'human-1');
 const ctx={ui:{notify:(s:string)=>notices.push(s)}};
 return {...h,calls,notices,run:()=>h.forceAnswer(ctx,{focus,left:2,spoke:0})};
}
const seat=(id:string,turns=0)=>({meta:{id},stat:{turns}});
test('busy focused seat never falls back to an untagged free seat',()=>{
 const h=harness([seat('other')],new Set(['target']));expect(h.run()).toBe(false);expect(h.calls).toHaveLength(0);
});
test('eligible focused seat is dispatched exactly once',()=>{
 const h=harness([seat('other'),seat('target',9)],new Set(['target']));expect(h.run()).toBe(true);expect(h.calls[0][1].meta.id).toBe('target');expect(h.run()).toBe(false);expect(h.calls).toHaveLength(1);
});
test('answered human never gets a fallback',()=>{
 const h=harness([seat('target')]);h.answeredHumans.add('human-1');expect(h.run()).toBe(false);expect(h.calls).toHaveLength(0);
});
test('reply attributed to older human does not suppress fallback',()=>{
 const h=harness([seat('target')]);h.answeredHumans.add('human-0');expect(h.run()).toBe(true);
});
