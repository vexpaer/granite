export interface DomainEvent { schemaVersion:1; eventId:string; name:string; at:string; payload:unknown; }
const listeners=new Set<(name:string,event:DomainEvent)=>void>();
export const appEvents={
  emit(name:string,payload:unknown={}){const event:DomainEvent={schemaVersion:1,eventId:crypto.randomUUID(),name,at:new Date().toISOString(),payload:JSON.parse(JSON.stringify(payload))};for(const listener of listeners){try{listener(name,event);}catch{/* subscribers cannot break core */}}},
  onAny(listener:(name:string,event:DomainEvent)=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};},
};
