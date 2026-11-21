// Files going into a message: picked, pasted or dropped, they upload to the host at
// once and wait as tiles (a thumbnail for an image), not as paths in the text. In a
// session's composer each is also a chip where it was put ("@paste.png", its token),
// and sending puts its path in that place; one with no token in the text (New
// dialog's, or its chip deleted as text) goes in front of the message.
import { showError } from './ask.tsx';
import { Icon } from './icons.tsx';
import type { HostApi } from './api.ts';
import type { Upload } from './uploads.ts';
import type { Attachment } from './attachmentText.ts';

export { attachmentChips, withAttachments, type Attachment } from './attachmentText.ts';

/** Changes the list the tiles are in. */
export type EditAttachments = (edit: (list: Attachment[]) => Attachment[]) => void;

let attachmentId = 0;

/** A small data: URL of an image, for its tile. The CSP allows data: images but not blob:. */
async function thumbnail(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 192 / Math.min(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

/**
 * Tiles for `files` at once, from the local files, and their uploads to the host
 * behind them. A tile whose upload fails goes, and says so.
 */
export async function uploadAttachments(client: Pick<HostApi, 'upload'>, files: File[], edit: EditAttachments, place?: (added: Attachment[]) => void): Promise<void> {
  const added: Attachment[] = files.map((f) => ({ id: ++attachmentId, name: f.name || 'paste', image: f.type.startsWith('image/') }));
  // Given their tokens and put in the text (the composer), before the tiles show.
  place?.(added);
  edit((l) => [...l, ...added]);
  const set = (id: number, patch: Partial<Attachment>) => edit((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  await Promise.all(
    files.map(async (f, i) => {
      const { id, image } = added[i];
      if (image) thumbnail(f).then((src) => set(id, { src }), () => {});
      try {
        set(id, { path: await client.upload(f) });
      } catch (e) {
        edit((l) => l.filter((x) => x.id !== id));
        showError(e, `Couldn't attach ${added[i].name}`);
      }
    }),
  );
}

/** Tiles again for uploads a message already carries (Edit on a queued one), with their tokens. */
export function uploadedAttachments(uploads: (Upload & { token?: string })[], client: Pick<HostApi, 'fs'>): Attachment[] {
  return uploads.map((u) => ({ id: ++attachmentId, name: u.name, image: u.image, path: u.path, token: u.token, src: u.image ? client.fs.url(u.path) : undefined }));
}

export function AttachmentTiles({ files, onRemove }: { files: Attachment[]; onRemove: (id: number) => void }) {
  if (!files.length) return null;
  return (
    <div className="composer-files">
      {files.map((f) => (
        <div key={f.id} className={`composer-file ${f.image ? 'image' : ''} ${f.path ? '' : 'uploading'}`} title={f.path ?? `Uploading ${f.name}…`}>
          {f.image ? (
            f.src && <img src={f.src} alt={f.name} />
          ) : (
            <>
              {/* A file, not the Files tab's folder. */}
              <Icon name="file" size={16} />
              <span className="composer-file-name">{f.name}</span>
            </>
          )}
          <button type="button" className="composer-file-remove" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => onRemove(f.id)}>
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
