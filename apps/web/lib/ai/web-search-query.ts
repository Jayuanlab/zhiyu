/** Apply explicit search scope to the provider request, not only its receipt. */
export function directedWebSearchQuery(query:string,domains:unknown,dateFrom:unknown){
  const filters:string[]=[];
  if(domains!==undefined){
    if(!Array.isArray(domains)||domains.length>3||domains.some(d=>typeof d!=='string'||d.length>253||!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(d)))throw Error('Invalid search domain filter');
    if(domains.length)filters.push(`(${[...new Set(domains)].map(d=>`site:${d}`).join(' OR ')})`);
  }
  if(dateFrom!==undefined){
    if(typeof dateFrom!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)||!Number.isFinite(Date.parse(dateFrom))||new Date(dateFrom).toISOString().slice(0,10)!==dateFrom)throw Error('Invalid search date filter');
    filters.push(`after:${dateFrom}`);
  }
  return [query,...filters].join(' ');
}
