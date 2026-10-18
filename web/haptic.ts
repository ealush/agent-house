// A light tap you feel, where iOS apps give one: a held row's menu opening, a swipe
// passing the point where letting go acts, a sliding sidebar settling.
//
// iOS Safari has no vibration API, but its <input type="checkbox" switch> ticks the
// switch haptic when flipped, a label's click included (iOS 18+). So one hidden switch
// is flipped through its label. iOS gives it only inside a user gesture (a tap, a
// lift), so a tick timed from a held finger may not come. Android uses vibrate(); a
// desktop has nothing to feel.

let label: HTMLLabelElement | null = null;

const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function haptic(): void {
  if (typeof document === 'undefined' || !coarse()) return;
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(8);
    return;
  }
  if (!label) {
    label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9px;top:-9px';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.append(input);
    // Its clicks are nobody else's: a menu that closes on a click outside must not see them.
    label.addEventListener('click', (e) => e.stopPropagation());
    document.body.append(label);
  }
  label.click();
}
