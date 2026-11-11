// Dates and times as the app shows them, each from one formatter made once. Building an
// Intl formatter is the costly part (toLocaleTimeString with options builds one per
// call): a conversation's timestamps cost ~18 ms of an open at 4x CPU that way.

const memo = <T>(make: () => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

const clockFmt = memo(() => new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }));
const dayFmt = memo(() => new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }));
const dayYearFmt = memo(() => new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' }));
const stampFmt = memo(() => new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));

/** "14:05" (or "2:05 PM"). */
export const clock = (d: Date | number) => clockFmt().format(d);
/** "Nov 10". */
export const day = (d: Date | number) => dayFmt().format(d);
/** "Nov 10, 2026". */
export const dayYear = (d: Date | number) => dayYearFmt().format(d);
/** "Nov 10, 14:05". */
export const stamp = (d: Date | number) => stampFmt().format(d);
