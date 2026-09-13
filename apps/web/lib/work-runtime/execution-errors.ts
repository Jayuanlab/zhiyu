export class ExecutionLeaseError extends Error {
  constructor(public readonly code:'not_found'|'invalid_lease'|'lease_lost'|'result_conflict'){super(code);}
  get status(){return this.code==='not_found'?404:this.code==='invalid_lease'?400:409;}
}
