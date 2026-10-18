/// <reference types="vite/client" />

// <input type="checkbox" switch>: an on/off switch, Safari's own (with its haptic on an
// iPhone) where supported (web/switch.ts). React passes the attribute through as written.
declare module 'react' {
  interface InputHTMLAttributes<T> {
    switch?: '';
  }
}
export {};
