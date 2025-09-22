const outputs = [];
const expected = 7;
let done = false;

function record(kind, detail) {
  const entry = {
    kind,
    detail,
    now: Date.now(),
    random: Math.random().toFixed(6)
  };
  outputs.push(entry);
  maybeFinish();
}

function maybeFinish() {
  if (done) {
    return;
  }
  if (outputs.length >= expected) {
    done = true;
    console.log(JSON.stringify({ sequence: outputs }, null, 2));
  }
}

record('start', 'bootstrap');

Promise.resolve().then(() => {
  record('microtask', 'resolved');
});

setTimeout(() => {
  record('timeout', 'zero-delay');
}, 0);

setTimeout(() => {
  record('timeout', 'medium-delay');
}, 5);

setTimeout(() => {
  record('timeout', 'long-delay');
}, 12);

let intervalCount = 0;
const handle = setInterval(() => {
  intervalCount += 1;
  record('interval', `tick-${intervalCount}`);
  if (intervalCount >= 2) {
    clearInterval(handle);
  }
}, 4);

setTimeout(() => {
  maybeFinish();
}, 100);
