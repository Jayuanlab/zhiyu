const http = require('node:http');
const fs = require('node:fs');
const [mode, readyFile] = process.argv.slice(2);
console.log('fixture started');
if (mode === 'exit') { console.error('fixture startup failure'); process.exit(7); }
const server = http.createServer((req, res) => {
  if (mode === 'hang') return;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, service: 'quant-service' }));
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(readyFile, JSON.stringify({ port: server.address().port })));
