import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, readBase64, useAction } from '../components';
import { labelMap, t } from '../i18n';

// Help while submitting: the AI coach (R2-16), voice and photo input (R2-17).

export interface IdeaFields {
  title: string;
  problem: string;
  solution: string;
  benefit: string;
}
type FieldName = keyof IdeaFields;
interface Message {
  role: 'coach' | 'user';
  text: string;
  asks?: FieldName | null;
}

const FIELD_LABEL = labelMap('submitAssist.field', ['title', 'problem', 'solution', 'benefit'] as const);

/** Dialog with the coach; every answer can fill the form fields, the dialog stays as original text. */
export function Coach({ fields, confidential, onFields, onTranscript, onClose }: {
  fields: IdeaFields;
  confidential: boolean;
  onFields: (f: Partial<IdeaFields>) => void;
  onTranscript: (text: string) => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [boundary, setBoundary] = useState<{ label: string }[]>([]);
  const { busy, error, run } = useAction();
  const logRef = useRef<HTMLOListElement>(null);

  const ask = async (msgs: Message[]) => {
    const res = await run(() => api.post<{ reply: string; asks: FieldName | null; fields: Record<FieldName, string | null>; done: boolean; boundary: { label: string }[] }>('/api/ai/coach', { messages: msgs, fields, confidential }));
    if (!res) return;
    const next = [...msgs, { role: 'coach' as const, text: res.reply, asks: res.asks }];
    setMessages(next);
    setBoundary(res.boundary ?? []);
    const changed = Object.fromEntries(Object.entries(res.fields).filter(([, v]) => v)) as Partial<IdeaFields>;
    if (Object.keys(changed).length) onFields(changed);
    onTranscript(next.map((m) => `${m.role === 'coach' ? t('submitAssist.transcript.coach') : t('submitAssist.transcript.me')}: ${m.text}`).join('\n'));
  };

  useEffect(() => {
    void ask([]);
    // Start the dialog once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [messages]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const msgs = [...messages, { role: 'user' as const, text: input.trim() }];
    setMessages(msgs);
    setInput('');
    await ask(msgs);
  };

  return (
    <section className="card coach" aria-labelledby="h-coach">
      <div className="row spread">
        <h2 id="h-coach">{t('submitAssist.heading')}</h2>
        <button type="button" onClick={onClose}>{t('submitAssist.toForm')}</button>
      </div>
      <p className="small muted">{t('submitAssist.intro')}{confidential ? t('submitAssist.confidential') : ''}</p>
      <ol className="coach-log" ref={logRef} aria-live="polite">
        {messages.map((m, i) => (
          <li key={i} className={m.role}>
            <span className="sr-only">{m.role === 'coach' ? t('submitAssist.speakerCoach') : t('submitAssist.speakerYou')}</span>
            {m.text}
            {m.role === 'coach' && m.asks && <span className="small muted">{t('submitAssist.forField', { field: FIELD_LABEL[m.asks] })}</span>}
          </li>
        ))}
      </ol>
      {boundary.length > 0 && (
        <div className="alert warn" role="alert">{t('submitAssist.boundary', { label: boundary[0].label })}</div>
      )}
      <ErrorBox error={error} />
      <form onSubmit={send} className="row">
        <label htmlFor="coach-input" className="sr-only">{t('submitAssist.yourAnswer')}</label>
        <textarea id="coach-input" rows={2} value={input} onChange={(e) => setInput(e.target.value)} style={{ flex: 1 }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(e as unknown as FormEvent); } }} />
        <VoiceButton confidential={confidential} onText={(x) => setInput((v) => (v ? `${v} ${x}` : x))} />
        <button className="primary" disabled={busy || !input.trim()}>{t('submitAssist.send')}</button>
      </form>
    </section>
  );
}

/** Voice input: records in the browser and transcribes via the AI gateway (R2-17). */
export function VoiceButton({ confidential, onText }: { confidential: boolean; onText: (t: string) => void }) {
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const { busy, error, run } = useAction();
  if (typeof window === 'undefined' || !('MediaRecorder' in window) || !navigator.mediaDevices) return null;
  const toggle = async () => {
    if (recording) {
      rec.current?.stop();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return;
    }
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream);
    r.ondataavailable = (e) => chunks.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      setRecording(false);
      const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
      const audio = await readBase64(new File([blob], t('submitAssist.recordingFile'), { type: blob.type }));
      const res = await run(() => api.post<{ text: string }>('/api/ai/transcribe', { audio, mime: blob.type, confidential }));
      if (res?.text) onText(res.text);
    };
    rec.current = r;
    r.start();
    setRecording(true);
  };
  return (
    <>
      <button type="button" onClick={toggle} disabled={busy} aria-pressed={recording}>
        {recording ? t('submitAssist.voice.stop') : busy ? t('submitAssist.voice.busy') : t('submitAssist.voice.start')}
      </button>
      {error && <span className="small" role="alert" style={{ color: 'var(--red)' }}>{error.message}</span>}
    </>
  );
}

/** Photo or screenshot: the AI describes it and suggests field texts (R2-17). */
export function PhotoSuggest({ confidential, onApply }: { confidential: boolean; onApply: (f: Partial<IdeaFields>) => void }) {
  const [res, setRes] = useState<{ description: string; title: string | null; problem: string | null; solution: string | null; builtin: boolean } | null>(null);
  const { busy, error, run } = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const image = await readBase64(file);
    const r = await run(() => api.post<any>('/api/ai/describe-image', { image, mime: file.type, confidential }));
    if (r) setRes(r);
  };
  return (
    <div className="stack">
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>{t('submitAssist.photo.button')}</button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => void pick(e.target.files?.[0])} />
      {busy && <p className="muted" aria-live="polite">{t('submitAssist.photo.busy')}</p>}
      <ErrorBox error={error} />
      {res && (
        <div className="alert info" role="status">
          <span className="badge accent">{t('submitAssist.photo.badge')}</span> {res.description}
          {!res.builtin && (res.title || res.problem || res.solution) && (
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" onClick={() => onApply(Object.fromEntries(Object.entries({ title: res.title, problem: res.problem, solution: res.solution }).filter(([, v]) => v)) as Partial<IdeaFields>)}>
                {t('submitAssist.photo.apply')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
