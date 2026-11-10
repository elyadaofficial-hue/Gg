import { tick } from '../lib/core.mjs';
// Runs every minute (UTC cron). Decides per-subscription in the user's own timezone.
export default async () => { console.log('evening-reset tick', JSON.stringify(await tick())); };
export const config = { schedule: '* * * * *' };
