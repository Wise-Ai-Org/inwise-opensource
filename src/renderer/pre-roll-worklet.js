// AudioWorkletProcessor: circular ring buffer for 5 seconds of mono 16kHz PCM.
// Runs in AudioWorkletGlobalScope — plain JS, no TypeScript compilation or webpack runtime injection.

const BUFFER_SIZE = 16000 * 5; // 80000 samples (~640 KB)

class PreRollProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(BUFFER_SIZE);
    this._writeIdx = 0;

    // Handle snapshot requests: post back a linearised copy in chronological order.
    this.port.addEventListener('message', (e) => {
      if (e.data?.type !== 'snapshot') return;
      const snapshot = new Float32Array(BUFFER_SIZE);
      // Oldest samples start at _writeIdx; wrap around to 0.
      const tail = BUFFER_SIZE - this._writeIdx;
      snapshot.set(this._buf.subarray(this._writeIdx), 0);
      snapshot.set(this._buf.subarray(0, this._writeIdx), tail);
      this.port.postMessage({ type: 'snapshot', buffer: snapshot.buffer }, [snapshot.buffer]);
    });
    this.port.start();
  }

  process(inputs, _outputs, _params) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._writeIdx] = ch[i];
      this._writeIdx = (this._writeIdx + 1) % BUFFER_SIZE;
    }
    return true;
  }
}

registerProcessor('pre-roll-processor', PreRollProcessor);
