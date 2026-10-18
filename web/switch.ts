// On/off settings are switches, as on iOS and macOS: <input type="checkbox" switch>.
// Safari draws its own (an iPhone ticks a haptic as it flips); where the browser has
// no switch, styles.css draws one under :root:not([data-native-switch]).

export function installSwitch() {
  if (typeof document === 'undefined') return;
  const probe = document.createElement('input');
  probe.type = 'checkbox';
  // Safari reflects the attribute as a property; others leave it unknown.
  if ('switch' in probe) document.documentElement.dataset.nativeSwitch = '';
}
