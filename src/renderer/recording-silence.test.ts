import { RecordingSilenceWatchdog } from './recording-silence';

function assertEqual(actual: boolean, expected: boolean, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const timeoutMs = 1_000;
const watchdog = new RecordingSilenceWatchdog(timeoutMs, 0.01, 0);

assertEqual(watchdog.observe(0, 999), false, 'quiet should not notify before the timeout');
assertEqual(watchdog.observe(0, 1_000), true, 'quiet should notify at the timeout');
assertEqual(watchdog.observe(0, 2_000), false, 'a quiet stretch should only notify once');
assertEqual(watchdog.observe(0.02, 2_100), false, 'sound should rearm the watchdog');
assertEqual(watchdog.observe(0, 3_099), false, 'rearmed quiet should wait for a full timeout');
assertEqual(watchdog.observe(0, 3_100), true, 'a new quiet stretch should notify');

watchdog.reset(4_000);
assertEqual(watchdog.observe(Number.NaN, 5_000), true, 'missing signal should count as silence');

console.log('recording-silence watchdog tests passed');
