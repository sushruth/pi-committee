import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DiscussionBudget, compactTopic } from "./conversation.ts";

const source = readFileSync(new URL("./committee.ts", import.meta.url), "utf8");
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const production = [
  section("  const record =", "  // one real pi session"),
  section("  const packet =", "  const deliberate ="),
  section("  const deliberate =", "  // ---- one cycle"),
  section("  const takeReply =", "  // ---- deliberation:"),
  section("  const unreadQueue =", "  const requestDiscussion ="),
  section("  async function round(", "  async function runRound(").replace("async function round(", "async function guardedRound("),
  section("  async function runRound(", "  /** fire a reply"),
  section("  const afterRound =", '  pi.on("input",'),
  section('  pi.on("input",', "  async function runCycles"),
].join("\n");

function harness(send?: (id: string, text: string) => Promise<any>) {
  const create = new Function("DiscussionBudget", "compactTopic", "send", new Bun.Transpiler({ loader: "ts" }).transformSync(`
    const PUBLIC = ["human", "speak", "error"];
    const events = [], displayed = [], disk = [], microtasks = [], rounds = [], dispatched = [];
    const queued = [], queuedIds = [], pausedTexts = [], failedHumans = new Map();
    const speakers = ["a", "b"].map((id, i) => ({meta:{id},stat:{turns:i},sent:0,inflight:false,session:{send:(text)=>send(id,text)}}));
    let liveRecap = "", recapStatus = "discussing", recapAfter = "", cycleNo = 0, floorHolder = null;
    let lastHumanId = "", lastHumanText = "", ongoing, activeCtx, heldWhilePaused = false;
    let paused = false, active = true, roundPending = false, delibActive = false, delibRound, delibStamp, delibLive;
    let generation = 0;
    let pendingReplies = 0, latestIntentionsId;
    const roomGen = {capture:()=>generation, accepts:(t)=>t===generation};
    const byId = (id)=>speakers.find((s)=>s.meta.id===id);
    const handlers = {};
    const pi = {on:(name,fn)=>handlers[name]=fn,getSessionName:()=>"named",setSessionName:()=>{}};
    const publish = (e)=>{const ev={id:"event-"+(events.length+1),cycle:cycleNo,...e}; record(ev); displayed.push(ev); return ev;};
    const ctx = {ui:{setStatus:()=>{},notify:()=>{}}};
    const focusOf = ()=>undefined, focusOfQueue = ()=>undefined;
    const drawQueue = ()=>{}, drawRecap = ()=>{}, drawDeliberating = ()=>{}, refresh = ()=>{}, saveSessions = ()=>{};
    const setState = ()=>{}, syncBusy = ()=>{}, account = ()=>{}, diag = ()=>{};
    const freeSeats = ()=>speakers.filter((s)=>!s.inflight);
    const rulesVersion = ()=>"v", rulesText = ()=>"rules", roster = ()=>"a b", personaOf = ()=>"", ledger = ()=>"", spendLine = ()=>"";
    const lastLedger = new Map(), cwd = "/room";
    const line = (e)=>"["+e.id+" "+e.author+"] "+e.text;
    const budget = ()=>1, deliberationSchema = {}, WRAP_UP = .1;
    const intentionSchema = {}, timeoutMs = 1;
    const converge = ()=>"tiny coordination", appetite = (n)=>Math.pow(2,-(n-1)/4);
    const dispatch = (...args)=>dispatched.push(args), forceAnswer = ()=>false;
    const appendFileSync = (_path,text)=>disk.push(JSON.parse(text)), logPath = "log";
    const queueMicrotask = (fn)=>microtasks.push(fn);
    const round = (...args)=>{rounds.push(args);};
    const newState = (focus)=>({n:1,spoke:0,focus,discussion:new DiscussionBudget()});
    const titleFrom = (text)=>text;
    ${production}
    return {events,displayed,disk,queued,queuedIds,speakers,failedHumans,rounds,dispatched,
      record,publish,packet,pruneQueue,unreadQueue,takeReply,
      runRound:(state)=>runRound(ctx,state), guardedRound:(state)=>guardedRound(ctx,state),afterRound:(state)=>afterRound(ctx,state),
      input:(text)=>handlers.input({text,source:"interactive"},ctx),
      deliberate:(state)=>deliberate([...speakers],state,generation),
      state:newState(), setRecap:(text)=>liveRecap=text,
      setPaused:(value)=>paused=value, switchGeneration:()=>generation++,
      getRecap:()=>liveRecap, getAfter:()=>recapAfter,
      flush:()=>microtasks.splice(0).forEach((fn)=>fn())};
  `));
  return create(DiscussionBudget, compactTopic, send ?? (async (id) => ({ speaker: id, ok: true, payload: { action: "ready" } })));
}

test("submitting snapshots the exact displayed recap immediately before the human message", async () => {
  const h = harness();
  h.setRecap("Existing discovery; still disputed.");
  await h.input("Consider this too");
  expect(h.displayed.map((e: any) => e.kind)).toEqual(["recap", "human"]);
  expect(h.displayed[0].text).toBe("Existing discovery; still disputed.");
  expect(h.getRecap()).toBe("");
  h.setRecap("Later finding");
  expect(h.displayed[0].text).toBe("Existing discovery; still disputed.");
});

test("pending messages reach the next packet together and remain queued for other seats", async () => {
  const h = harness();
  await h.input("first pending message");
  await h.input("second pending message");
  const first = h.packet(h.speakers[0], "respond", "");
  expect(first).toContain("first pending message");
  expect(first).toContain("second pending message");
  h.speakers[0].sent = h.speakers[0].pendingSent;
  h.pruneQueue();
  expect(h.queued).toHaveLength(2);
  h.speakers[1].sent = h.speakers[0].sent;
  h.pruneQueue();
  expect(h.queued).toHaveLength(0);
  expect(h.packet(h.speakers[0], "respond", "")).not.toContain("first pending message");
});

test("a failed seat keeps messages pending without immediately retrying the same segment", async () => {
  const h = harness(); await h.input("request");
  h.failedHumans.set("a", h.getAfter());
  expect(h.unreadQueue(h.speakers[0])).toBe(false);
  h.pruneQueue(); expect(h.queued).toHaveLength(1);
  await h.input("new steering");
  expect(h.unreadQueue(h.speakers[0])).toBe(true);
});

test("late response recap cannot overwrite the new human segment", async () => {
  const h = harness(); await h.input("old request");
  const old = h.getAfter();
  await h.input("new request");
  h.takeReply({ speaker: "a", ok: true, payload: { action: "speak", text: "Late answer", recap: "Old summary" } }, old, "");
  expect(h.getRecap()).toBe("");
  expect(h.events.at(-1).text).toBe("Late answer");
});

test("concurrent reports retain both outcomes and repeats do not start another cycle", async () => {
  const h = harness(); await h.input("request");
  for (const [speaker, recap] of [["a", "First outcome"], ["b", "Second outcome"]]) {
    h.takeReply({ speaker, ok: true, payload: { action: "speak", text: recap, recap } }, h.getAfter(), "");
  }
  expect(h.getRecap()).toBe("First outcome\nSecond outcome");
  expect(h.takeReply({ speaker: "a", ok: true, payload: { action: "repeat", ref: h.events.find((e: any) => e.author === "a").id } })).toBe(0);
});

test("replay replaces deliberation snapshots and restores their latest recap", () => {
  const h = harness();
  h.record({id:"human",kind:"human",cycle:1,text:"request"});
  h.record({id:"discussion",kind:"deliberation",text:"first exchange"});
  h.record({id:"discussion",kind:"deliberation",text:"all exchanges",data:{recap:"Latest outcome",recapAfter:"human"}});
  expect(h.events).toHaveLength(2);
  expect(h.events[1].text).toBe("all exchanges");
  expect(h.getRecap()).toBe("Latest outcome");
});

test("deliberation absorbs queued steering at its next exchange and retains every exchange", async () => {
  const packets: string[] = []; let h: ReturnType<typeof harness>;
  let injected = false;
  h = harness(async (id, text) => {
    packets.push(text);
    if (!injected) { injected = true; await h.input("new evidence A"); await h.input("new evidence B"); }
    return {speaker:id,ok:true,payload:{action:"ready",text:"Discussed position",recap:"Evidence reviewed"}};
  });
  await h.input("initial question");
  const full = await h.deliberate(h.state);
  expect(full).toContain("Exchange 1"); expect(full).toContain("Exchange 2");
  const second = packets.find((p) => p.includes("exchange 2"))!;
  expect(second).toContain("new evidence A"); expect(second).toContain("new evidence B");
  expect(h.queued).toHaveLength(0);
  expect(h.getRecap()).toBe("Evidence reviewed");
  expect(h.events.filter((e:any)=>e.kind==="deliberation")).toHaveLength(1);
  expect(h.disk.at(-1).data.status).toBe("concluded");
});

test("a discussion request includes holding seats and the least-spoken seat reports", async () => {
  const phases: string[] = [];
  const h = harness(async (id, text) => {
    const intention = text.endsWith("Phase: intention.");
    phases.push(`${id}:${intention ? "intention" : "discussion"}`);
    return {speaker:id,ok:true,payload:intention ? {preference:id==="a" ? "deliberate" : "wait"} : {action:"ready",text:"Position"}};
  });
  h.speakers[1].stat.turns = -1;
  await h.input("Discuss this");
  await h.runRound(h.state);
  expect(phases).toContain("b:discussion");
  expect(h.dispatched).toHaveLength(1);
  expect(h.dispatched[0][1].meta.id).toBe("b");
  expect(h.dispatched[0][2]).toContain("Report for the room");
});

test("a pending round cannot overlap another poll of the same seats", async () => {
  const resolve: (()=>void)[] = [];
  const h = harness((id) => new Promise((done) => resolve.push(()=>done({speaker:id,ok:true,payload:{preference:"wait"}}))));
  const first = h.guardedRound(h.state);
  expect(await h.guardedRound(h.state)).toBe(0);
  expect(resolve).toHaveLength(2);
  resolve.forEach((done)=>done());
  await first;
});

test("regular public rounds age the shared coordination decay", () => {
  const h = harness();
  const before = h.state.discussion.weight;
  h.state.spoke = 1;
  h.afterRound(h.state);
  expect(h.state.n).toBe(2);
  expect(h.state.discussion.round).toBe(2);
  expect(h.state.discussion.weight).toBeLessThan(before);
});

test("a failed discussion participant does not loop and an available seat reports", async () => {
  let exchanges = 0;
  const h = harness(async (id, text) => {
    if (text.endsWith("Phase: intention.")) return { speaker: id, ok: true, payload: { preference: "deliberate" } };
    exchanges++;
    return id === "a" ? { speaker: id, ok: false, error: "offline" } : { speaker: id, ok: true, payload: { action: "discuss", text: "One participant is unavailable" } };
  });
  await h.input("Discuss this");
  await h.runRound(h.state);
  expect(exchanges).toBe(2);
  expect(h.dispatched).toHaveLength(1);
  expect(h.dispatched[0][1].meta.id).toBe("b");
  expect(h.dispatched[0][2]).toContain("offline");
});
