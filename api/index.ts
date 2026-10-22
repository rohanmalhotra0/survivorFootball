// Vercel invokes this handler per request. It must never start a listener,
// open SQLite, write a local database, or depend on an in-process timer.
import { createHostedEntry } from '../server/hosted/entry.js';
export default createHostedEntry();
