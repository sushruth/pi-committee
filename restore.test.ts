import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { titleFrom } from "./title.ts";

const source = readFileSync(new URL("./committee.ts", import.meta.url), "utf8");
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const transpiler = new Bun.Transpiler({ loader: "ts" });

test("restore displays conversation and recap once, excluding usage and coordination", async () => {
  const make = new Function(transpiler.transformSync(`
    const PUBLIC = ["human", "speak", "error"], speakers = [], roomId = "restored";
    const events = ["human", "speak", "phase", "deliberation", "recap", "usage", "intention"].map((kind, i) => ({id: "event-"+i, kind, author: "seat", text: kind}));
    const entries = [{type:"custom_message", customType:"committee", display:true, details:{...events[0],roomId}}];
    const displayed = [], notices = [];
    let shown = false;
    const boot = ()=>{}, checkEngines = async()=>{};
    const displayEvent = (ev)=>{displayed.push(ev);entries.push({type:"custom_message",customType:"committee",display:true,details:{...ev,roomId}})};
    const ctx = {sessionManager:{getBranch:()=>entries},ui:{notify:(text)=>notices.push(text)}};
    ${section("  const show =", '  pi.registerCommand("queue",')}
    return {show:()=>show(ctx), displayed, notices, reload:()=>shown=false};
  `));
  const h = make();
  await h.show();
  expect(h.displayed.map((e: any) => e.kind)).toEqual(["speak", "phase", "deliberation", "recap"]);
  await h.show();
  h.reload();
  await h.show();
  expect(h.displayed).toHaveLength(4);
});

test("restoring a different room does not confuse reused event ids", async () => {
  const make = new Function(transpiler.transformSync(`
    const PUBLIC=["human"], speakers=[], roomId="new-room", events=[{id:"event-1",kind:"human",author:"you",text:"same words"}];
    let shown=false;
    const displayed=[], boot=()=>{}, checkEngines=async()=>{}, displayEvent=(e)=>displayed.push(e);
    const ctx={sessionManager:{getBranch:()=>[{type:"custom_message",customType:"committee",display:true,details:{...events[0],roomId:"other-room"}}]},ui:{notify:()=>{}}};
    ${section("  const show =", '  pi.registerCommand("queue",')}
    return async()=>{await show(ctx);return displayed};
  `));
  expect(await make()()).toHaveLength(1);
});

for (const [existing, expected] of [[undefined, "⚒ Describe this room"], ["⚒ 2026-10-28T09-14-16-499Z", "⚒ Describe this room"], ["My custom name", "My custom name"]]) {
  test(`restoring names preserves custom names: ${existing}`, async () => {
    const make = new Function("titleFrom", "existing", transpiler.transformSync(`
      const events=[{kind:"human",text:"Describe this room"}], speakers=[{}], roomId="timestamp";
      ${section("  const currentRoomTitle =", '  let liveRecap =')}
      let name=existing, active=false, activeCtx, enableMode;
      const pi={getSessionName:()=>name,setSessionName:(n)=>name=n,appendEntry:()=>{}};
      const onboarding=async()=>true, show=async()=>{}, applyMode=()=>{};
      ${section("  enableMode = async", "  // ---- onboarding:")}
      return async()=>{await enableMode({ui:{notify:()=>{}}});return name};
    `));
    expect(await make(titleFrom, existing)()).toBe(expected);
  });
}
