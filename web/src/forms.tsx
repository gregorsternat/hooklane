import { useState } from 'react';
import type { FormEvent } from 'react';
import { destination, ingestResult, request, safeURL } from './api';
import type { Destination } from './api';
import {
  Button,
  ErrorBox,
  Icon,
  Input,
  Modal,
  SelectField,
  SwitchField,
  Textarea,
} from './components';
import {
  navigate,
  useMutation,
  useStableKey,
  useDestinationIndex,
} from './hooks';

export function DestinationForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Destination;
  onClose: () => void;
  onSaved: (destination: Destination) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setURL] = useState(initial?.url ?? '');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [inputError, setInputError] = useState('');
  const mutation = useMutation();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setInputError('');
    try {
      const parsed = new URL(url);
      if (
        !['https:', 'http:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error();
    } catch {
      setInputError(
        'Enter an HTTP(S) URL without credentials, a query string, or a fragment.',
      );
      return;
    }
    if ((secret || !initial) && new TextEncoder().encode(secret).length < 32) {
      setInputError('The signing secret must contain at least 32 bytes.');
      return;
    }
    const result = await mutation.run((signal) =>
      request(
        initial ? `/destinations/${initial.id}` : '/destinations',
        destination,
        {
          method: initial ? 'PUT' : 'POST',
          signal,
          body: JSON.stringify({
            name: name.trim(),
            url: url.trim(),
            signing_secret: secret,
            enabled,
          }),
        },
      ),
    );
    if (result) {
      setSecret('');
      onSaved(result);
    }
  }
  return (
    <Modal
      title={initial ? 'Edit destination' : 'Add destination'}
      onClose={onClose}
      busy={mutation.pending}
    >
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-body form-stack">
          <div>
            <label htmlFor="destination-name">Name</label>
            <Input
              id="destination-name"
              autoFocus
              value={name}
              onChange={setName}
              maxLength={120}
              required
              placeholder="e.g. Billing service"
            />
          </div>
          <div>
            <label htmlFor="destination-url">Endpoint URL</label>
            <Input
              id="destination-url"
              type="url"
              value={url}
              onChange={setURL}
              required
              maxLength={2048}
              placeholder="https://api.example.com/webhooks"
              aria-describedby="destination-url-hint"
            />
            <p id="destination-url-hint" className="field-hint">
              HTTP and private networks require server configuration. No
              credentials, query parameters, or fragments.
            </p>
          </div>
          <div>
            <label htmlFor="destination-secret">
              {initial ? 'Replace signing secret' : 'Signing secret'}
              {initial && <span className="optional"> (optional)</span>}
            </label>
            <Input
              id="destination-secret"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={setSecret}
              required={!initial}
              maxLength={512}
              aria-describedby="destination-secret-hint"
            />
            <p id="destination-secret-hint" className="field-hint">
              At least 32 bytes.{' '}
              {initial && 'Leave blank to keep the current secret. '}
              The secret cannot be retrieved after saving.
            </p>
          </div>
          <div className="checkbox-label">
            <SwitchField
              id="destination-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
            <label htmlFor="destination-enabled">Enable delivery</label>
          </div>
          <ErrorBox message={inputError || mutation.error} />
        </div>
        <footer className="modal-footer">
          <Button
            type="button"
            className="button"
            disabled={mutation.pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="button primary"
            disabled={mutation.pending}
          >
            {mutation.pending
              ? 'Saving…'
              : initial
                ? 'Save changes'
                : 'Create destination'}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
export function EventComposer({
  onClose,
  notify,
}: {
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const index = useDestinationIndex();
  const [destinationID, setDestinationID] = useState('');
  const [type, setType] = useState('');
  const [payload, setPayload] = useState(
    '{\n  "message": "Hello from Hooklane"\n}',
  );
  const [inputError, setInputError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const mutation = useMutation();
  const idempotencyKey = useStableKey();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setInputError('');
    if (!destinationID) {
      setInputError('Choose a destination.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setInputError('Enter valid JSON.');
      return;
    }
    setSubmitted(true);
    const result = await mutation.run((signal) =>
      request('/events', ingestResult, {
        method: 'POST',
        signal,
        headers: { 'Idempotency-Key': idempotencyKey() },
        body: JSON.stringify({
          destination_id: destinationID,
          type: type.trim(),
          payload: parsed,
        }),
      }),
    );
    if (result) {
      setPayload('');
      notify(result.duplicate ? 'Event already accepted.' : 'Event queued.');
      navigate(`/deliveries/${result.delivery.id}`);
      onClose();
    }
  }
  const available = index.destinations.filter(
    (item) => item.enabled && !item.archived,
  );
  return (
    <Modal title="Send event" onClose={onClose} busy={mutation.pending}>
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-body form-stack">
          <div>
            <label htmlFor="event-destination">Destination</label>
            <SelectField
              id="event-destination"
              required
              value={destinationID}
              disabled={submitted}
              onValueChange={setDestinationID}
              placeholder="Choose a destination"
              options={available.map((item) => ({
                value: item.id,
                label: `${item.name} · ${safeURL(item.url)}`,
              }))}
            />
            {available.length === 0 && (
              <p className="field-hint">
                Add an active destination to send events.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="event-type">Event type</label>
            <Input
              id="event-type"
              value={type}
              disabled={submitted}
              onChange={setType}
              required
              maxLength={120}
              placeholder="e.g. invoice.paid"
            />
          </div>
          <div>
            <label htmlFor="event-payload">JSON payload</label>
            <Textarea
              id="event-payload"
              className="code-input"
              value={payload}
              disabled={submitted}
              onChange={(e) => setPayload(e.target.value)}
              rows={8}
              spellCheck={false}
              required
            />
          </div>
          {submitted && !mutation.pending && mutation.error && (
            <p className="info-note">
              Retry keeps the same content and idempotency key. Close this
              dialog to compose a different event.
            </p>
          )}
          <ErrorBox message={inputError || mutation.error || index.error} />
        </div>
        <footer className="modal-footer">
          <Button
            type="button"
            className="button"
            disabled={mutation.pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="button primary"
            disabled={mutation.pending || available.length === 0}
          >
            {mutation.pending
              ? 'Sending…'
              : submitted
                ? 'Retry same event'
                : 'Send event'}
            <Icon name="arrow" size={16} />
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
