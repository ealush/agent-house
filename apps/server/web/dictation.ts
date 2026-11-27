// Dictation through the browser's speech recognition: what's said lands in the box for you
// to read before it goes. Where the browser has none (Firefox), there's no mic button.
import { useEffect, useRef, useState } from 'react';
import { showNotice } from './ask.tsx';

type Recognition = { start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null; continuous: boolean; interimResults: boolean; lang: string };
const SpeechRecognition: (new () => Recognition) | undefined = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

/** Whether this browser can dictate at all. */
export const canDictate = !!SpeechRecognition;

/** Text after what's there, with a space between when it needs one. */
export const appendSaid = (text: string, said: string) => `${text}${text && !/\s$/.test(text) ? ' ' : ''}${said.trim()}`;

/** Start and stop dictation; each finished phrase goes to `onSaid`. Stops when the view goes. */
export function useDictation(onSaid: (said: string) => void) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const said = useRef(onSaid);
  said.current = onSaid;
  useEffect(() => () => recognition.current?.stop(), []);

  function toggle() {
    if (!SpeechRecognition) return;
    if (listening) return recognition.current?.stop();
    const r = new SpeechRecognition();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || 'en-US';
    r.onresult = (e: any) => {
      let heard = '';
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard += e.results[i][0].transcript;
      if (heard.trim()) said.current(heard.trim());
    };
    r.onend = () => setListening(false);
    r.onerror = (e: any) => {
      setListening(false);
      if (e?.error === 'not-allowed') showNotice('Microphone blocked', 'Allow microphone access for this site, then try again.');
    };
    recognition.current = r;
    r.start();
    setListening(true);
  }

  return { available: canDictate, listening, toggle };
}
