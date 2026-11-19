// npm run teardown: delete every zone this repo built in your Keycard org, forget them locally, and
// stop the quick tunnel. The next npm start builds everything again.
import { api, describeError, listDemoZones, state } from './keycard.js';
import { stopTunnel } from './tunnel.js';

try {
  api();
  for (const z of await listDemoZones()) {
    console.log(`Deleting zone “${z.name}” (${z.id})`);
    await api().zones.delete(z.id);
  }
  state.clear();
  stopTunnel();
  console.log('✓ Done. npm start builds the zones again.');
} catch (e) {
  console.error(`✗ ${describeError(e)}`);
  process.exit(1);
}
