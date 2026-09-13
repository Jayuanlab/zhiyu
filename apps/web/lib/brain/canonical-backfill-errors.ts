export class CanonicalBackfillError extends Error {
  constructor(public readonly code:string,message:string,public readonly status:number=409){super(message);this.name='CanonicalBackfillError';}
}
