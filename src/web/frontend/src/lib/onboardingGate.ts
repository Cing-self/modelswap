// App-level onboarding gate cache. The first paint must never flash the
// product shell before the wizard redirect resolves, so the App gates all
// rendering on this value: null = unknown (check server), true = skip.
// SessionStorage primes repeat loads so returning users paint instantly.
let cached: boolean | null = null;

export function primeOnboardingFromSession(): boolean {
  if (cached === null && sessionStorage.getItem('okit.onboarded') === '1') {
    cached = true;
  }
  return cached === true;
}

export function getOnboardingDoneCache(): boolean | null {
  return cached;
}

export function setOnboardingDone(v: boolean) {
  cached = v;
  if (v) sessionStorage.setItem('okit.onboarded', '1');
  else sessionStorage.removeItem('okit.onboarded');
}
