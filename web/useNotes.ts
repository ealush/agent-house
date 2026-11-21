import { useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { NotesBook } from './notes.ts';

// This page's notes, for the host that serves it (a peer's notes stay on the peer).
let shared: NotesBook | null = null;
export function notesBook(): NotesBook {
  if (!shared) {
    shared = new NotesBook(api, { key: 'ah.notes' });
    // Closing the tab mid-word keeps the word.
    addEventListener('pagehide', () => shared?.saveNow());
    addEventListener('online', () => shared?.syncSoon(0));
  }
  return shared;
}

/** Redraws on every change to the notes. */
export function useNotes(): NotesBook {
  const book = notesBook();
  useSyncExternalStore(book.subscribe, book.getVersion);
  return book;
}
