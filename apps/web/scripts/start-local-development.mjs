// Single-process local development entry. Next's CLI forks a worker without
// hostname argv; keeping startup here lets the existing bind policy validate
// the same explicit address that the HTTP server actually uses.
import {assertAuthBinding} from './auth-bind-policy.mjs';
import {installSerializedDevTypeWrites} from './serialize-dev-type-writes.mjs';
import {installHiddenNextWorkers} from './hidden-next-workers.mjs';
const args=process.argv.slice(2);
const value=flag=>args[args.indexOf(flag)+1];
const hostname=args.includes('--hostname')?value('--hostname'):'127.0.0.1';
const port=args.includes('--port')?Number(value('--port')):3000;
if(!['127.0.0.1','localhost','::1'].includes(hostname)||!Number.isInteger(port)||port<1||port>65535)throw Error('Local development requires a loopback hostname and valid port');
if(!args.includes('--hostname'))process.argv.push('--hostname',hostname);
assertAuthBinding(process.env.AUTH_MODE,process.argv);
process.env.NODE_ENV='development';
// Match next dev: route modules use this flag to select development manifests.
process.env.__NEXT_DEV_SERVER='1';
installSerializedDevTypeWrites(process.cwd(),process.env.ZHIYU_REVIEW_BUILD);
installHiddenNextWorkers();
const {startServer}=await import('next/dist/server/lib/start-server.js');
await startServer({dir:process.cwd(),isDev:true,hostname,port,allowRetry:false});
