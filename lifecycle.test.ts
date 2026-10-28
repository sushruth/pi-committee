import {test, expect} from "bun:test";
import {planRoomStart,roomBinding,RoomGeneration} from "./lifecycle.ts";
for (const [reason,on,binding,expected] of [
 ["startup",true,undefined,{kind:"fresh"}], ["startup",true,"old",{kind:"restore",roomId:"old"}],
 ["new",true,"old",{kind:"fresh"}], ["new",false,"old",{kind:"off"}],
 ["resume",true,"old",{kind:"restore",roomId:"old"}], ["resume",true,undefined,{kind:"off"}],
 ["reload",true,"old",{kind:"restore",roomId:"old"}], ["reload",true,undefined,{kind:"off"}],
 ["fork",true,"old",{kind:"fork",sourceRoomId:"old"}], ["fork",false,undefined,{kind:"off"}],
] as const) test(`${reason}/${on}/${binding}`,()=>expect(planRoomStart(reason,on,binding)).toEqual(expected));
test("latest valid custom binding wins",()=>expect(roomBinding([
 {type:"custom",customType:"committee-room",data:{roomId:"first"}},
 {type:"custom",customType:"committee-room",data:{roomId:"second"}},
 {type:"custom",customType:"committee-room",data:{roomId:"../escape"}},
])).toBe("second"));
test("no metadata means no binding",()=>expect(roomBinding([])).toBeUndefined());
test("late callbacks cannot enter new room",()=>{const g=new RoomGeneration(), old=g.capture();expect(g.accepts(old)).toBe(true);g.advance();expect(g.accepts(old)).toBe(false);expect(g.accepts(g.capture())).toBe(true)});
