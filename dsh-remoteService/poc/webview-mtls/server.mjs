import https from 'node:https';
import { readFileSync } from 'node:fs';
const server = https.createServer({
  key: readFileSync('.build/server-key.pem'),
  cert: readFileSync('.build/server-cert.pem'),
  ca: readFileSync('.build/ca.pem'),
  requestCert: true,
  rejectUnauthorized: true,
}, (req, res) => {
  const peer = req.socket.getPeerCertificate();
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<html><body><h1>MTLS OK: ${peer.subject?.CN ?? 'nobody'}</h1></body></html>`);
});
server.listen(0, '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
