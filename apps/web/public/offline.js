let timer;
let checking = false;
let reloading = false;
let retryMs = 5000;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(checkHub, retryMs);
  retryMs = Math.min(30000, retryMs * 2);
}
async function checkHub() {
  if (checking || reloading) return;
  clearTimeout(timer);
  if (document.visibilityState === 'hidden') { schedule(); return; }
  checking = true;
  try {
    // Transport reachability only: never cache or read an owner document here.
    const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (response.ok) { reloading = true; window.location.reload(); }
  } catch { /* The tailnet or hub is still unavailable. */ }
  finally { checking = false; }
  if (!reloading) schedule();
}
document.querySelector('button').addEventListener('click', () => window.location.reload());
window.addEventListener('online', () => { void checkHub(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void checkHub(); });
void checkHub();
