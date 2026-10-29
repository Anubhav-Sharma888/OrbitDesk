import type {SecretStore} from '../shared/contracts.js';
export class MemorySecrets implements SecretStore {
 private values=new Map<string,string>();
 get(key:string):string|null {return this.values.get(key)??null}
 set(key:string,value:string):void {this.values.set(key,value)}
 remove(key:string):void {this.values.delete(key)}
 keys(prefix:string):string[] {return [...this.values.keys()].filter(k=>k.startsWith(prefix))}
 atomic<T>(work:()=>T):T{return work()}
}
