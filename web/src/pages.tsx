import { useState } from 'react';
import type { FormEvent } from 'react';
import { Table } from '@/components/motion/table';
import type { TableColumn } from '@/components/motion/table';
import {
  delivery,
  deliveryDetail,
  destination,
  event,
  eventDetail,
  noContent,
  page,
  queryString,
  replayResult,
  request,
  safeURL,
  stats,
  statuses,
  terminal,
} from './api';
import type { Delivery, Destination, WebhookEvent } from './api';
import {
  Badge,
  Button,
  ButtonLink,
  Input,
  SelectField,
  Confirm,
  DateValue,
  Empty,
  ErrorBox,
  Icon,
  Loading,
  PageHeader,
  Pager,
  Panel,
  Timestamp,
} from './components';
import { DestinationForm, EventComposer } from './forms';
import {
  navigate,
  useMutation,
  useQuery,
  useStableKey,
  useDestinationIndex,
} from './hooks';
import { shortID } from './format';

type Notice = { notify: (message: string) => void };
const number = new Intl.NumberFormat('en');
const knownStatusLabels = {
  pending: 'Queued',
  delivering: 'Delivering',
  retrying: 'Retrying',
  succeeded: 'Delivered',
  dead: 'Failed',
  canceled: 'Canceled',
};
function destinationName(id: string, destinations: Destination[]) {
  return destinations.find((item) => item.id === id)?.name ?? shortID(id);
}
function Refresh({ onClick }: { onClick: () => void }) {
  return (
    <Button className="button" onClick={onClick}>
      <Icon name="refresh" size={16} />
      Refresh
    </Button>
  );
}
function DestinationCell({
  id,
  destinations,
}: {
  id: string;
  destinations: Destination[];
}) {
  return (
    <span className="destination-cell">
      <span className="endpoint-icon">
        <Icon name="destinations" size={15} />
      </span>
      {destinationName(id, destinations)}
    </span>
  );
}
function DeliveryTable({
  items,
  destinations,
  compact = false,
}: {
  items: Delivery[];
  destinations: Destination[];
  compact?: boolean;
}) {
  if (items.length === 0) return <Empty title="No deliveries yet" />;
  const columns: TableColumn<Delivery>[] = [
    {
      key: 'id',
      header: 'Delivery',
      width: '190px',
      cell: (item) => (
        <a href={`#/deliveries/${item.id}`} className="record-link mono">
          {shortID(item.id)}
          <span className="record-subtitle">
            {item.replay_of ? 'Replay' : `Event ${shortID(item.event_id)}`}
          </span>
        </a>
      ),
    },
    {
      key: 'destination_id',
      header: 'Destination',
      width: '220px',
      cell: (item) => (
        <DestinationCell id={item.destination_id} destinations={destinations} />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '140px',
      cell: (item) => <Badge status={item.status} />,
    },
    ...(!compact
      ? [
          {
            key: 'attempt_count',
            header: 'Attempts',
            width: '160px',
            cell: (item: Delivery) => (
              <>
                <span className="mono">{item.attempt_count}</span>
                {item.last_status_code > 0 && (
                  <span className="http-code">
                    HTTP {item.last_status_code}
                  </span>
                )}
              </>
            ),
          },
        ]
      : []),
    {
      key: 'created_at',
      header: 'Created',
      width: '160px',
      cell: (item) => <Timestamp value={item.created_at} />,
    },
    {
      key: 'inspect',
      header: <span className="sr-only">Open delivery</span>,
      width: '64px',
      cell: (item) => (
        <a
          href={`#/deliveries/${item.id}`}
          className="row-arrow"
          aria-label={`Inspect delivery ${shortID(item.id)}`}
        >
          <Icon name="arrow" size={17} />
        </a>
      ),
    },
  ];
  return (
    <Table
      className="records-table"
      data={items}
      columns={columns}
      getRowId={(item) => item.id}
      rowHeight={64}
      virtualized={false}
      height={Math.min((items.length + 1) * 64, 640)}
    />
  );
}
export function Dashboard() {
  const summary = useQuery('/stats', stats);
  const recent = useQuery('/deliveries?limit=8', page(delivery));
  const index = useDestinationIndex();
  const s = summary.data;
  const settled = s ? s.succeeded + s.dead : 0;
  return (
    <>
      <PageHeader
        title="Overview"
        actions={
          <>
            <Refresh
              onClick={() => {
                summary.refresh();
                recent.refresh();
              }}
            />
            <ButtonLink href="#/events?compose=true" className="button primary">
              <Icon name="plus" size={17} />
              Send event
            </ButtonLink>
          </>
        }
      />
      <ErrorBox
        message={summary.error || recent.error}
        retry={() => {
          summary.refresh();
          recent.refresh();
        }}
      />
      {summary.loading && <Loading />}
      {s && (
        <>
          <div className="metrics-grid">
            <Metric label="Total events" value={s.events} icon="events" />
            <Metric
              label="Delivered"
              value={s.succeeded}
              detail={
                settled
                  ? `${((s.succeeded / settled) * 100).toFixed(1)}% of completed deliveries`
                  : undefined
              }
              icon="check"
              good
            />
            <Metric
              label="In progress"
              value={s.pending + s.delivering + s.retrying}
              detail={`${number.format(s.retrying)} scheduled for retry`}
              icon="deliveries"
            />
            <Metric
              label="Failed"
              value={s.dead}
              icon="refresh"
              warning={s.dead > 0}
            />
          </div>
        </>
      )}
      {s?.destinations === 0 && (
        <div className="onboarding-strip">
          <div>
            <strong>No destinations</strong>
            <p>Add an endpoint to start sending events.</p>
          </div>
          <ButtonLink
            className="button primary"
            href="#/destinations?create=true"
          >
            Add destination
            <Icon name="plus" size={16} />
          </ButtonLink>
        </div>
      )}
      <Panel
        title="Recent deliveries"
        action={
          <a className="text-link" href="#/deliveries">
            View all
            <Icon name="arrow" size={16} />
          </a>
        }
      >
        {recent.loading ? (
          <Loading label="Loading recent deliveries…" />
        ) : recent.data ? (
          <DeliveryTable
            items={recent.data.items}
            destinations={index.destinations}
            compact
          />
        ) : null}
      </Panel>
    </>
  );
}
function Metric({
  label,
  value,
  detail,
  icon,
  good = false,
  warning = false,
}: {
  label: string;
  value: number;
  detail?: string;
  icon: 'events' | 'check' | 'deliveries' | 'refresh';
  good?: boolean;
  warning?: boolean;
}) {
  return (
    <section
      className={`metric ${good ? 'metric-good' : ''} ${warning ? 'metric-warning' : ''}`}
    >
      <div className="metric-label">
        {label}
        <Icon name={icon} size={18} />
      </div>
      <strong>{number.format(value)}</strong>
      {detail && <p>{detail}</p>}
    </section>
  );
}
export function Destinations({ notify }: Notice) {
  const [history, setHistory] = useState(['']);
  const query = useQuery(
    `/destinations${queryString({ limit: '25', before: history.at(-1) ?? '' })}`,
    page(destination),
  );
  const [form, setForm] = useState<Destination | 'new' | null>(() =>
    window.location.hash.includes('create=true') ? 'new' : null,
  );
  const [archive, setArchive] = useState<Destination | null>(null);
  const mutation = useMutation();
  async function toggle(item: Destination) {
    const result = await mutation.run((signal) =>
      request(`/destinations/${item.id}`, destination, {
        method: 'PUT',
        signal,
        body: JSON.stringify({
          name: item.name,
          url: item.url,
          enabled: !item.enabled,
        }),
      }),
    );
    if (result) {
      notify(result.enabled ? 'Destination resumed.' : 'Destination paused.');
      query.refresh();
    }
  }
  async function archiveSelected() {
    if (!archive) return;
    const completed = await mutation.run(async (signal) => {
      await request(`/destinations/${archive.id}`, noContent, {
        method: 'DELETE',
        signal,
      });
      return true;
    });
    if (completed) {
      setArchive(null);
      notify('Destination archived.');
      query.refresh();
    }
  }
  return (
    <>
      <PageHeader
        title="Destinations"
        actions={
          <>
            <Refresh onClick={query.refresh} />
            <Button className="button primary" onClick={() => setForm('new')}>
              <Icon name="plus" size={17} />
              Add destination
            </Button>
          </>
        }
      />
      <ErrorBox message={query.error} retry={query.refresh} />
      <ErrorBox message={!archive ? mutation.error : ''} />
      <Panel>
        {query.loading ? (
          <Loading />
        ) : query.data?.items.length === 0 ? (
          <Empty
            title="No destinations"
            action={
              <Button className="button primary" onClick={() => setForm('new')}>
                <Icon name="plus" size={16} />
                Add destination
              </Button>
            }
          />
        ) : (
          query.data && (
            <DestinationTable
              items={query.data.items}
              pending={mutation.pending}
              onEdit={setForm}
              onToggle={(item) => void toggle(item)}
              onArchive={setArchive}
            />
          )
        )}
        {query.data && (
          <Pager
            history={history}
            next={query.data.next_cursor}
            change={setHistory}
          />
        )}
      </Panel>
      {form && (
        <DestinationForm
          initial={form === 'new' ? undefined : form}
          onClose={() => setForm(null)}
          onSaved={(item) => {
            setForm(null);
            notify(`Destination “${item.name}” saved.`);
            query.refresh();
          }}
        />
      )}
      {archive && (
        <Confirm
          title="Archive this destination?"
          description={`“${archive.name}” will stop accepting new events and deliveries. Its event and attempt history will remain available. Archiving cannot be undone from the console.`}
          label="Archive destination"
          busy={mutation.pending}
          error={mutation.error}
          onConfirm={() => void archiveSelected()}
          onClose={() => setArchive(null)}
          destructive
        />
      )}
    </>
  );
}
function DestinationTable({
  items,
  pending,
  onEdit,
  onToggle,
  onArchive,
}: {
  items: Destination[];
  pending: boolean;
  onEdit: (item: Destination) => void;
  onToggle: (item: Destination) => void;
  onArchive: (item: Destination) => void;
}) {
  const columns: TableColumn<Destination>[] = [
    {
      key: 'name',
      header: 'Destination',
      width: '320px',
      cell: (item) => (
        <div className="destination-name">
          <div>
            <strong>{item.name}</strong>
            <span className="endpoint-url" title={safeURL(item.url)}>
              {safeURL(item.url)}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: 'enabled',
      header: 'Status',
      width: '140px',
      cell: (item) => (
        <Badge
          status={
            item.archived ? 'archived' : item.enabled ? 'active' : 'paused'
          }
        />
      ),
    },
    {
      key: 'created_at',
      header: 'Created',
      width: '160px',
      cell: (item) => <Timestamp value={item.created_at} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      width: '270px',
      cell: (item) =>
        !item.archived && (
          <div className="row-actions">
            <Button
              className="button small"
              aria-label={`Edit ${item.name}`}
              onClick={() => onEdit(item)}
            >
              Edit
            </Button>
            <Button
              className="button small"
              disabled={pending}
              aria-label={`${item.enabled ? 'Pause' : 'Resume'} ${item.name}`}
              onClick={() => onToggle(item)}
            >
              {item.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button
              className="button small quiet-danger"
              disabled={pending}
              aria-label={`Archive ${item.name}`}
              onClick={() => onArchive(item)}
            >
              Archive
            </Button>
          </div>
        ),
    },
  ];
  return (
    <Table
      className="records-table"
      data={items}
      columns={columns}
      getRowId={(item) => item.id}
      rowHeight={64}
      virtualized={false}
      height={Math.min((items.length + 1) * 64, 640)}
    />
  );
}
export function Deliveries() {
  const [eventID, setEventID] = useState(
    () =>
      new URLSearchParams(window.location.hash.split('?')[1]).get('event_id') ??
      '',
  );
  const [status, setStatus] = useState(
    () =>
      new URLSearchParams(window.location.hash.split('?')[1]).get('status') ??
      '',
  );
  const [destinationID, setDestinationID] = useState('');
  const [history, setHistory] = useState(['']);
  const index = useDestinationIndex();
  const query = useQuery(
    `/deliveries${queryString({ limit: '25', status, event_id: eventID, destination_id: destinationID, before: history.at(-1) ?? '' })}`,
    page(delivery),
  );
  return (
    <>
      <PageHeader
        title="Deliveries"
        actions={<Refresh onClick={query.refresh} />}
      />
      <ErrorBox message={query.error || index.error} retry={query.refresh} />
      <Panel>
        <div className="filter-bar">
          <div className="filter-field">
            <label htmlFor="delivery-status-filter">Status</label>
            <SelectField
              id="delivery-status-filter"
              aria-label="Status"
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                setHistory(['']);
              }}
              options={[
                { value: '', label: 'All statuses' },
                ...statuses.map((value) => ({
                  value,
                  label: knownStatusLabels[value],
                })),
              ]}
            />
          </div>
          <DestinationFilter
            value={destinationID}
            items={index.destinations}
            onChange={(value) => {
              setDestinationID(value);
              setHistory(['']);
            }}
          />
          {eventID && (
            <span className="event-filter-label">Event {shortID(eventID)}</span>
          )}
          {(status || destinationID || eventID) && (
            <Button
              className="button small"
              onClick={() => {
                setStatus('');
                setEventID('');
                setDestinationID('');
                setHistory(['']);
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
        {query.loading ? (
          <Loading />
        ) : query.data?.items.length === 0 && (status || destinationID) ? (
          <Empty title="No matching deliveries">
            Try another status or destination, or clear your filters.
          </Empty>
        ) : (
          query.data && (
            <DeliveryTable
              items={query.data.items}
              destinations={index.destinations}
            />
          )
        )}
        {query.data && (
          <Pager
            history={history}
            next={query.data.next_cursor}
            change={setHistory}
          />
        )}
      </Panel>
    </>
  );
}
function DestinationFilter({
  value,
  items,
  onChange,
}: {
  value: string;
  items: Destination[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="filter-field">
      <label htmlFor="destination-filter">Destination</label>
      <SelectField
        id="destination-filter"
        aria-label="Destination"
        value={value}
        onValueChange={onChange}
        options={[
          { value: '', label: 'All destinations' },
          ...items.map((item) => ({
            value: item.id,
            label: `${item.name}${item.archived ? ' (archived)' : ''}`,
          })),
        ]}
      />
    </div>
  );
}
export function Events({ notify }: Notice) {
  const [destinationID, setDestinationID] = useState('');
  const [typeInput, setTypeInput] = useState('');
  const [type, setType] = useState('');
  const [history, setHistory] = useState(['']);
  const [compose, setCompose] = useState(() =>
    window.location.hash.includes('compose=true'),
  );
  const index = useDestinationIndex();
  const query = useQuery(
    `/events${queryString({ limit: '25', destination_id: destinationID, type, before: history.at(-1) ?? '' })}`,
    page(event),
  );
  function filter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setType(typeInput.trim());
    setHistory(['']);
  }
  return (
    <>
      <PageHeader
        title="Events"
        actions={
          <>
            <Refresh onClick={query.refresh} />
            <Button className="button primary" onClick={() => setCompose(true)}>
              <Icon name="plus" size={17} />
              Send event
            </Button>
          </>
        }
      />
      <ErrorBox message={query.error || index.error} retry={query.refresh} />
      <Panel>
        <div className="filter-bar">
          <form className="type-filter" onSubmit={filter}>
            <label htmlFor="type-filter">Event type</label>
            <div>
              <Input
                id="type-filter"
                value={typeInput}
                onChange={setTypeInput}
                placeholder="e.g. invoice.paid"
                maxLength={120}
              />
              <Button type="submit" className="button small">
                Filter
              </Button>
            </div>
          </form>
          <DestinationFilter
            value={destinationID}
            items={index.destinations}
            onChange={(value) => {
              setDestinationID(value);
              setHistory(['']);
            }}
          />
          {(type || destinationID) && (
            <Button
              className="button small"
              onClick={() => {
                setType('');
                setTypeInput('');
                setDestinationID('');
                setHistory(['']);
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
        {query.loading ? (
          <Loading />
        ) : query.data?.items.length === 0 ? (
          <Empty
            title={
              type || destinationID ? 'No matching events' : 'No events yet'
            }
            action={
              !type && !destinationID ? (
                <Button className="button" onClick={() => setCompose(true)}>
                  Send an event
                  <Icon name="arrow" size={16} />
                </Button>
              ) : undefined
            }
          >
            {type || destinationID
              ? 'Try another event type or destination.'
              : undefined}
          </Empty>
        ) : (
          query.data && (
            <EventTable
              items={query.data.items}
              destinations={index.destinations}
            />
          )
        )}
        {query.data && (
          <Pager
            history={history}
            next={query.data.next_cursor}
            change={setHistory}
          />
        )}
      </Panel>
      {compose && (
        <EventComposer onClose={() => setCompose(false)} notify={notify} />
      )}
    </>
  );
}
function EventTable({
  items,
  destinations,
}: {
  items: WebhookEvent[];
  destinations: Destination[];
}) {
  const columns: TableColumn<WebhookEvent>[] = [
    {
      key: 'type',
      header: 'Event',
      width: '230px',
      cell: (item) => (
        <a href={`#/events/${item.id}`} className="record-link">
          {item.type}
          <span className="record-subtitle mono">{shortID(item.id)}</span>
        </a>
      ),
    },
    {
      key: 'destination_id',
      header: 'Destination',
      width: '220px',
      cell: (item) => (
        <DestinationCell id={item.destination_id} destinations={destinations} />
      ),
    },
    {
      key: 'payload_bytes',
      header: 'Payload',
      width: '140px',
      cell: (item) =>
        item.redacted ? (
          <Badge status="redacted" />
        ) : (
          <span className="muted mono">
            {number.format(item.payload_bytes)} B
          </span>
        ),
    },
    {
      key: 'created_at',
      header: 'Created',
      width: '160px',
      cell: (item) => <Timestamp value={item.created_at} />,
    },
    {
      key: 'inspect',
      header: <span className="sr-only">Inspect</span>,
      width: '64px',
      cell: (item) => (
        <a
          className="row-arrow"
          href={`#/events/${item.id}`}
          aria-label={`Inspect event ${shortID(item.id)}`}
        >
          <Icon name="arrow" size={17} />
        </a>
      ),
    },
  ];
  return (
    <Table
      className="records-table"
      data={items}
      columns={columns}
      getRowId={(item) => item.id}
      rowHeight={64}
      virtualized={false}
      height={Math.min((items.length + 1) * 64, 640)}
    />
  );
}
export function EventView({ id, notify }: { id: string } & Notice) {
  const query = useQuery(`/events/${encodeURIComponent(id)}`, eventDetail);
  const index = useDestinationIndex();
  const [confirm, setConfirm] = useState(false);
  const mutation = useMutation();
  const data = query.data;
  const canRedact =
    data &&
    !data.event.redacted &&
    data.deliveries.every((item) => terminal(item.status));
  async function redact() {
    const completed = await mutation.run(async (signal) => {
      await request(`/events/${encodeURIComponent(id)}/payload`, noContent, {
        method: 'DELETE',
        signal,
      });
      return true;
    });
    if (completed) {
      setConfirm(false);
      notify('Payload redacted.');
      query.refresh();
    }
  }
  return (
    <>
      <a className="back-link" href="#/events">
        ← All events
      </a>
      <PageHeader
        title={data?.event.type ?? 'Event'}
        actions={<Refresh onClick={query.refresh} />}
      />
      <ErrorBox message={query.error} retry={query.refresh} />
      {query.loading && <Loading />}
      {data && (
        <>
          <Panel
            title="Event metadata"
            action={
              data.event.redacted ? <Badge status="redacted" /> : undefined
            }
          >
            <dl className="detail-grid">
              <div>
                <dt>Event ID</dt>
                <dd className="mono break-word">{data.event.id}</dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd>
                  {destinationName(
                    data.event.destination_id,
                    index.destinations,
                  )}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  <DateValue value={data.event.created_at} />
                </dd>
              </div>
              <div>
                <dt>Original payload size</dt>
                <dd>{number.format(data.event.payload_bytes)} bytes</dd>
              </div>
              <div className="detail-wide">
                <dt>Payload SHA-256</dt>
                <dd className="mono break-word hash-value">
                  {data.event.payload_sha256}
                </dd>
              </div>
            </dl>
          </Panel>
          <Panel
            title="Deliveries for this event"
            description="Latest 100 deliveries"
            action={
              <a
                className="text-link"
                href={`#/deliveries?event_id=${encodeURIComponent(data.event.id)}`}
              >
                View all
                <Icon name="arrow" size={16} />
              </a>
            }
          >
            <DeliveryTable
              items={data.deliveries}
              destinations={index.destinations}
            />
          </Panel>
          <section className="danger-zone">
            <div>
              <h2>Payload retention</h2>
              <p>
                {data.event.redacted
                  ? 'The payload has been removed. This event can no longer be replayed.'
                  : 'Permanently remove the stored payload while preserving audit metadata. All deliveries must be terminal before redaction.'}
              </p>
            </div>
            <Button
              className="button quiet-danger"
              disabled={!canRedact}
              onClick={() => setConfirm(true)}
            >
              {data.event.redacted ? 'Payload redacted' : 'Redact payload'}
            </Button>
          </section>
        </>
      )}
      {confirm && (
        <Confirm
          title="Permanently redact this payload?"
          description="The stored payload will be deleted. Metadata and delivery attempts will remain, but this event cannot be replayed afterward. This action cannot be undone."
          label="Redact payload"
          busy={mutation.pending}
          error={mutation.error}
          onClose={() => setConfirm(false)}
          onConfirm={() => void redact()}
          destructive
        />
      )}
    </>
  );
}
export function DeliveryView({ id, notify }: { id: string } & Notice) {
  const query = useQuery(
    `/deliveries/${encodeURIComponent(id)}`,
    deliveryDetail,
  );
  const index = useDestinationIndex();
  const [action, setAction] = useState<'replay' | 'cancel' | null>(null);
  const mutation = useMutation();
  const replayKey = useStableKey();
  const data = query.data;
  async function perform() {
    if (action === 'replay') {
      const result = await mutation.run((signal) =>
        request(`/deliveries/${encodeURIComponent(id)}/replay`, replayResult, {
          method: 'POST',
          headers: { 'Idempotency-Key': replayKey() },
          signal,
        }),
      );
      if (result) {
        notify(
          result.duplicate
            ? 'Replay already queued. Opened the existing delivery.'
            : 'Replay queued as a new delivery.',
        );
        navigate(`/deliveries/${result.delivery.id}`);
        setAction(null);
      }
    } else {
      const completed = await mutation.run(async (signal) => {
        await request(
          `/deliveries/${encodeURIComponent(id)}/cancel`,
          noContent,
          { method: 'POST', signal },
        );
        return true;
      });
      if (completed) {
        notify('Delivery canceled.');
        setAction(null);
        query.refresh();
      }
    }
  }
  return (
    <>
      <a className="back-link" href="#/deliveries">
        ← All deliveries
      </a>
      <PageHeader
        title={`Delivery ${shortID(id)}`}
        actions={
          <>
            <Refresh onClick={query.refresh} />
            {data && terminal(data.delivery.status) && (
              <Button
                className="button primary"
                onClick={() => setAction('replay')}
              >
                <Icon name="refresh" size={16} />
                Replay delivery
              </Button>
            )}
            {data && ['pending', 'retrying'].includes(data.delivery.status) && (
              <Button
                className="button quiet-danger"
                onClick={() => setAction('cancel')}
              >
                Cancel delivery
              </Button>
            )}
          </>
        }
      />
      <ErrorBox message={query.error} retry={query.refresh} />
      {query.loading && <Loading />}
      {data && (
        <>
          <Panel
            title="Delivery summary"
            action={<Badge status={data.delivery.status} />}
          >
            <dl className="detail-grid">
              <div>
                <dt>Delivery ID</dt>
                <dd className="mono break-word">{data.delivery.id}</dd>
              </div>
              <div>
                <dt>Event</dt>
                <dd>
                  <a
                    href={`#/events/${data.delivery.event_id}`}
                    className="mono text-link"
                  >
                    {shortID(data.delivery.event_id)}
                    <Icon name="arrow" size={15} />
                  </a>
                </dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd>
                  {destinationName(
                    data.delivery.destination_id,
                    index.destinations,
                  )}
                </dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>{data.delivery.attempt_count}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  <DateValue value={data.delivery.created_at} />
                </dd>
              </div>
              <div>
                <dt>Last updated</dt>
                <dd>
                  <DateValue value={data.delivery.updated_at} />
                </dd>
              </div>
              <div>
                <dt>Next attempt</dt>
                <dd>
                  <DateValue value={data.delivery.next_attempt_at} />
                </dd>
              </div>
              <div>
                <dt>Last response</dt>
                <dd>
                  {data.delivery.last_status_code
                    ? `HTTP ${data.delivery.last_status_code}`
                    : 'No HTTP response'}
                </dd>
              </div>
              {data.delivery.replay_of && (
                <div>
                  <dt>Replay of</dt>
                  <dd>
                    <a
                      className="text-link mono"
                      href={`#/deliveries/${data.delivery.replay_of}`}
                    >
                      {shortID(data.delivery.replay_of)}
                      <Icon name="arrow" size={15} />
                    </a>
                  </dd>
                </div>
              )}
            </dl>
            {data.delivery.last_error && (
              <div className="delivery-note">
                {failureLabel(data.delivery.last_error)}
              </div>
            )}
          </Panel>
          <Panel title="Attempts">
            {data.attempts.length === 0 ? (
              <Empty title="Waiting for the first attempt">
                {data.delivery.status === 'canceled'
                  ? 'This delivery was canceled before an attempt completed.'
                  : 'The worker will attempt this delivery when its destination is enabled and it becomes due.'}
              </Empty>
            ) : (
              <ol className="timeline">
                {data.attempts.map((item) => (
                  <li key={item.id}>
                    <span
                      className={`timeline-marker ${item.status_code >= 200 && item.status_code < 300 ? 'timeline-success' : ''}`}
                    >
                      {item.number}
                    </span>
                    <div className="attempt-content">
                      <div className="attempt-heading">
                        <h3>Attempt {item.number}</h3>
                        <span
                          className={`response-badge ${item.status_code >= 200 && item.status_code < 300 ? 'response-success' : ''}`}
                        >
                          {item.status_code > 0
                            ? `HTTP ${item.status_code}`
                            : item.finished_at
                              ? 'No response'
                              : 'In progress'}
                        </span>
                        <span className="attempt-duration">
                          {number.format(item.duration_ms)} ms
                        </span>
                      </div>
                      {item.error_code && (
                        <p>{failureLabel(item.error_code)}</p>
                      )}
                      <span className="attempt-time">
                        <DateValue value={item.started_at} />
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </>
      )}
      {action && (
        <Confirm
          title={
            action === 'replay'
              ? 'Replay this delivery?'
              : 'Cancel this delivery?'
          }
          description={
            action === 'replay'
              ? 'A new delivery will send the original event to the destination. Earlier attempts stay unchanged. Your receiver should handle duplicate events safely. Redacted events or archived destinations cannot be replayed.'
              : 'Scheduled attempts will be stopped. A request already in flight may still reach the receiver.'
          }
          label={action === 'replay' ? 'Queue replay' : 'Cancel delivery'}
          busy={mutation.pending}
          error={mutation.error}
          onClose={() => setAction(null)}
          onConfirm={() => void perform()}
          destructive={action === 'cancel'}
        />
      )}
    </>
  );
}
function failureLabel(code: string): string {
  const labels: Record<string, string> = {
    timeout: 'The endpoint did not respond before the delivery timeout.',
    request_timeout:
      'The endpoint did not respond before the delivery timeout.',
    network_error: 'A network error prevented delivery.',
    connection_error: 'A connection to the endpoint could not be established.',
    http_error: 'The endpoint returned an unsuccessful HTTP response.',
    http_status: 'The endpoint returned an unsuccessful HTTP response.',
    destination_paused: 'The destination is paused.',
    destination_archived: 'The destination has been archived.',
    payload_redacted: 'The event payload has been redacted.',
    lease_expired: 'The worker lease expired before the attempt was completed.',
    blocked_address: 'The endpoint is blocked by the network policy.',
    ssrf_blocked: 'The endpoint is blocked by the network policy.',
  };
  return (
    labels[code] ??
    'The attempt could not complete successfully. Check the endpoint and its delivery configuration.'
  );
}
export function Guide() {
  const [copied, setCopied] = useState(false);
  const snippet = `curl --request POST "$HOOKLANE_URL/api/v1/events" \\\n  --header "Authorization: Bearer $HOOKLANE_INGEST_TOKEN" \\\n  --header "Idempotency-Key: $(uuidgen)" \\\n  --header "Content-Type: application/json" \\\n  --data '{\n    "destination_id": "YOUR_DESTINATION_ID",\n    "type": "invoice.paid",\n    "payload": { "invoice_id": "inv_123" }\n  }'`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <>
      <PageHeader title="Integration guide" />
      <div className="guide-layout">
        <div>
          <Panel title="Connect your endpoint">
            <div className="prose">
              <p>
                Create a destination with a name, an HTTPS endpoint URL, and a
                signing secret of at least 32 characters. Keep the same secret
                in your receiving application.
              </p>
              <p>
                The receiver must respond with a <code>2xx</code> status after
                accepting an event. Use a fast handler and process longer tasks
                asynchronously.
              </p>
              <a href="#/destinations?create=true" className="text-link">
                Create a destination
                <Icon name="arrow" size={16} />
              </a>
            </div>
          </Panel>
          <Panel
            title="Send an event"
            action={
              <Button className="button small" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy example'}
              </Button>
            }
          >
            <div className="prose">
              <p>
                Set <code>HOOKLANE_URL</code> to your instance URL and{' '}
                <code>HOOKLANE_INGEST_TOKEN</code> to its ingestion token.
              </p>
              <pre className="code-block">
                <code>{snippet}</code>
              </pre>
              <p>
                <strong>
                  Reuse the same idempotency key when retrying an API request.
                </strong>{' '}
                The server returns the existing event and delivery for a
                matching request. A different event requires a new key.
              </p>
              <p>
                Accepted events return <code>202</code>. Duplicate requests
                return <code>200</code>.
              </p>
              <a href="#/events?compose=true" className="text-link">
                Open event composer
                <Icon name="arrow" size={16} />
              </a>
            </div>
          </Panel>
          <Panel title="Verify and deduplicate">
            <div className="prose">
              <p>
                Verify every signature against the exact request bytes before
                decoding JSON. Check the signed timestamp to prevent old
                requests being reused.
              </p>
              <p>
                Deliveries are attempted at least once. Store processed event
                IDs and acknowledge known duplicates with a successful response.
                Replays keep the original event ID and receive a new delivery
                ID.
              </p>
              <p>
                See the repository API documentation for signature headers,
                retry limits, network allowlists, and retention settings.
              </p>
              <a href="#/deliveries" className="text-link">
                View deliveries
                <Icon name="arrow" size={16} />
              </a>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
