import {test, expect} from 'bun:test';
import {Speaker} from './speaker.ts';
import deliberationSchema from './schemas/deliberation.schema.json';
import intentionSchema from './schemas/intention.schema.json';
function harness(cli: string) {
  const s: any = Object.create(Speaker.prototype);
  Object.assign(s, {id:'test', opts:{cli,tools:'all'}, schema:{required:['action'],examples:[{action:'speak',text:'answer'}]}, work:{calls:1,chars:10}, nudged:false});
  const sent: any[] = []; let result: any;
  s.dispatch = (text: string) => sent.push({text,noTools:s.noTools});
  s.pending = (r: any) => {result=r};
  return {s,sent,result:()=>result};
}
for (const cli of ['pi','opencode']) {
 test(`${cli}: one tool-free recovery preserves work and sums usage`,()=>{
  const h=harness(cli);
  h.s.settleJson('<tool_call>bad</tool_call>',{}, {fresh:2,cached:3,out:4,cost:0.1});
  expect(h.sent.length).toBe(1); expect(h.sent[0].noTools).toBe(true); expect(h.result()).toBeUndefined();
  h.s.settleJson('{"action":"speak","text":"ok"}',{}, {fresh:5,cached:6,out:7,cost:0.2});
  expect(h.result().ok).toBe(true); expect(h.result().tools.calls).toBe(1);
  expect(h.result().usage.fresh).toBe(7); expect(h.result().usage.cached).toBe(9); expect(h.result().usage.out).toBe(11);
 });
 test(`${cli}: second malformed reply ends recovery`,()=>{
  const h=harness(cli); h.s.settleJson('bad',{}); h.s.settleJson('bad again',{});
  expect(h.sent.length).toBe(1); expect(h.result().ok).toBe(false);
 });
}
for (const cli of ['claude','codex']) test(`${cli}: no advisory recovery`,()=>{
 const h=harness(cli); h.s.settleJson('bad',{});
 expect(h.sent.length).toBe(0); expect(h.result().ok).toBe(false);
});
for (const text of ['null','[]','42']) test(`non-object ${text} is handled`,()=>{
 const h=harness('pi'); h.s.settleJson(text,{}); expect(h.sent.length).toBe(1);
});

for (const [action, expected] of [['speak','discuss'],['repeat','discuss'],['wait','ready'],['silent','ready']]) {
 test(`deliberation maps legacy ${action} to ${expected} without losing content`,()=>{
  const h=harness('codex'); h.s.schema=deliberationSchema;
  h.s.settleJson(JSON.stringify({action,text:'new evidence',discovery:true}),{});
  expect(h.result().ok).toBe(true);
  expect(h.result().payload).toEqual({action:expected,text:'new evidence',discovery:true});
  expect(h.result().tools.calls).toBe(1);
 });
}
test('regular replies keep their original actions',()=>{
 const h=harness('codex'); h.s.settleJson('{"action":"speak","text":"answer"}',{});
 expect(h.result().payload.action).toBe('speak');
});
for (const [action, expected] of [['discuss','deliberate'],['ready','speak']]) {
 test(`an intention in discussion shape maps ${action} to ${expected}`,()=>{
  const h=harness('codex'); h.s.schema=intentionSchema;
  h.s.settleJson(JSON.stringify({action,text:'  new\n evidence  '}),{});
  expect(h.result().payload.preference).toBe(expected);
  expect(h.result().payload.topic).toBe('new evidence');
 });
}
test('deliberation accepts an intention-shaped request to discuss',()=>{
 const h=harness('codex'); h.s.schema=deliberationSchema;
 h.s.settleJson('{"preference":"deliberate","text":"check the evidence"}',{});
 expect(h.result().payload.action).toBe('discuss');
});
