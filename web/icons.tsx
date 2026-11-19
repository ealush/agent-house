import { memo } from 'react';
// A handful of 24px stroke icons, inline so the page stays self-contained.
const PATHS: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.35-4.35',
  inbox: 'M4 13h4l1.5 3h5L16 13h4M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  sessions: 'M4 5h16v14H4zM8 10l2 2-2 2M12 14h4',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  back: 'M15 18l-6-6 6-6',
  files: 'M4 6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
  home: 'M4 11l8-7 8 7M6.5 9v11h11V9',
  'folder-plus': 'M4 6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM12 10.5v5M9.5 13h5',
  diff: 'M12 3v8M8 7h8M8 17h8M5 21h14',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  attach: 'M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6',
  recall: 'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5',
  up: 'M12 19V5M5 12l7-7 7 7',
  close: 'M6 6l12 12M18 6 6 18',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  shield: 'M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z',
  gear: 'M10.5 5.6L11 3.6L13 3.6L13.5 5.6L15.5 6.4L17.2 5.3L18.7 6.8L17.6 8.5L18.4 10.5L20.4 11L20.4 13L18.4 13.5L17.6 15.5L18.7 17.2L17.2 18.7L15.5 17.6L13.5 18.4L13 20.4L11 20.4L10.5 18.4L8.5 17.6L6.8 18.7L5.3 17.2L6.4 15.5L5.6 13.5L3.6 13L3.6 11L5.6 10.5L6.4 8.5L5.3 6.8L6.8 5.3L8.5 6.4ZM12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  panel: 'M4 5h16v14H4zM9 5v14',
  'panel-hide': 'M4 5h16v14H4zM9 5v14M13 10l3 2-3 2',
  terminal: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 9.5l3 2.5-3 2.5M12.5 15H17',
  chat: 'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM7.5 10h9M7.5 13h6',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 13a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-13M10 11v6M14 11v6',
  copy: 'M9 9h12v12H9zM5 15H4V4h11v1',
  check: 'M20 6 9 17l-5-5',
  commands: 'M4 7h16M4 12h7M4 17h16M14 10l3 2-3 2',
  keyboard: 'M2 5h20v14H2zM5.5 8h3.2v2.6H5.5zM10.4 8h3.2v2.6h-3.2zM15.3 8h3.2v2.6h-3.2zM5.5 13h13v2.4h-13z',
  'panel-right': 'M4 5h16v14H4zM15 5v14',
  'chevron-up': 'M6 14l6-6 6 6',
  'chevron-right': 'M10 6l6 6-6 6',
  'chevron-down': 'M6 10l6 6 6-6',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
  reply: 'M9 14 4 9l5-5M4 9h8.5a6 6 0 0 1 6 6v4',
  ban: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M7 7l10 10',
  view: 'M4 4h16v16H4zM4 12h16M7.5 7.2l2.4 1.6-2.4 1.6M8 15.5h8',
  'split-right': 'M4 5h16v14H4zM12 5v14',
  'split-below': 'M4 5h16v14H4zM4 12h16',
  'split-flip': 'M4 5h16v14H4zM12 5v14M4 12h16',
  'pane-close': 'M4 5h16v14H4zM9 9l6 6M15 9l-6 6',
  'pane-left': 'M4 5h16v14H4zM14 9l-4 3 4 3',
  'pane-right': 'M4 5h16v14H4zM10 9l4 3-4 3',
  'pane-up': 'M4 5h16v14H4zM9 14l3-4 3 4',
  'pane-down': 'M4 5h16v14H4zM9 10l3 4 3-4',
  pane: 'M4 5h16v14H4z',
  stop: 'M7 7h10v10H7z',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  fork: 'M6 3v12M18 9a9 9 0 0 1-9 9M6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  pin: 'M12 16v5M8 4h8l-1 6 3 3v2H6v-2l3-3z',
  queue: 'M4 6h16M4 12h16M4 18h10',
  stack: 'M12 3 3 7.5l9 4.5 9-4.5zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
  reload: 'M20 12a8 8 0 1 1-2.34-5.66L20 8M20 3v5h-5',
  external: 'M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5',
  sparkle: 'M12 3c.7 5.3 3.7 8.3 9 9-5.3.7-8.3 3.7-9 9-.7-5.3-3.7-8.3-9-9 5.3-.7 8.3-3.7 9-9z',
  model: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  effort: 'M12 14l4-4M4.5 18a9 9 0 1 1 15 0',
  flag: 'M5 21V4M5 4h12l-2.5 4.5L17 13H5',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
};

export type IconName = keyof typeof PATHS;

/** Pure, so a list re-rendering on a state tick doesn't redraw every icon in it. */
export const Icon = memo(function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' || name === 'grip' ? 3 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
});

/** ah's mark: `=>` stood on its end, an arrow up that reads as a house (the app icon's lines,
 *  `web/public/icon.svg`). Drawn in the text colour, so the logo tile sets it. */
export function AhMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" fill="none" stroke="currentColor" strokeWidth={90} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M268 492 512 248 756 492M404 548v228M620 548v228" />
    </svg>
  );
}
