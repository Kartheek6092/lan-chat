// Creates key.pem / cert.pem (self-signed) valid for localhost and this machine's LAN IPs.
const fs = require('fs');
const os = require('os');
const selfsigned = require('selfsigned');

(async () => {
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) altNames.push({ type: 7, ip: i.address });

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'lan-chat' }], {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.writeFileSync('key.pem', pems.private);
  fs.writeFileSync('cert.pem', pems.cert);
  console.log('Wrote key.pem and cert.pem for:', altNames.map(a => a.value || a.ip).join(', '));
  console.log('Re-run this if your LAN IP changes.');
})();
