export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type RoomAction =
  | { kind: "fresh" }
  | { kind: "restore"; roomId: string }
  | { kind: "fork"; sourceRoomId: string }
  | { kind: "off" };
export function roomBinding(entries: readonly { type: string; customType?: string; data?: unknown }[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "custom" || e.customType !== "committee-room") continue;
    const id = (e.data as {roomId?: unknown} | undefined)?.roomId;
    // Room ids must be path components, not paths.
    if (typeof id === "string" && id.length > 0 && id !== "." && id !== ".." && !/[\\/\x00]/.test(id)) return id;
  }
}
export function planRoomStart(reason: StartReason, enabled: boolean, binding?: string): RoomAction {
  // Session identity wins over a persistent launch flag during resume/reload.
  if (reason === "resume" || reason === "reload") return binding ? {kind:"restore", roomId:binding} : {kind:"off"};
  if (reason === "fork") return binding ? {kind:"fork", sourceRoomId:binding} : enabled ? {kind:"fresh"} : {kind:"off"};
  if (reason === "new") return enabled ? {kind:"fresh"} : {kind:"off"};
  // Startup with an explicitly resumed native session restores its existing binding.
  return binding ? {kind:"restore",roomId:binding} : enabled ? {kind:"fresh"} : {kind:"off"};
}
export class RoomGeneration {
  private value = 0;
  capture(): number { return this.value; }
  advance(): void { this.value++; }
  accepts(token: number): boolean { return token === this.value; }
}
