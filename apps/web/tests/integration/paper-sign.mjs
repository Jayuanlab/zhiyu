import {paperSignedHeaders} from '../../lib/quant/paper-client.ts';
let text='';for await(const chunk of process.stdin)text+=chunk;
const input=JSON.parse(text);
process.stdout.write(JSON.stringify(paperSignedHeaders(input.context,input.method,input.path,input.body)));
