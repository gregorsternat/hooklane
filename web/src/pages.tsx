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
import type {
  Delivery,
  Destination,
  WebhookEvent,
  ReplayReason,
  SchedulingState,
} from './api';
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
  useListRoute,
  detailLink,
  returnRoute,
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
    <a
      href={`#/destinations?destination_id=${encodeURIComponent(id)}`}
      className="destination-cell"
    >
      <span className="endpoint-icon">
        <Icon name="destinations" size={15} />
      </span>
      {destinationName(id, destinations)}
    </a>
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
        <a
          href={detailLink(`/deliveries/${item.id}`)}
          className="record-link mono"
        >
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
          href={detailLink(`/deliveries/${item.id}`)}
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
            <Metric
              label="Retained events"
              value={s.events}
              icon="events"
              href="#/events"
            />
            <Metric
              label="Delivered"
              href="#/deliveries?status=succeeded"
              value={s.succeeded}
              detail={
                settled
                  ? `${((s.succeeded / settled) * 100).toFixed(1)}% of delivered + failed records`
                  : undefined
              }
              icon="check"
              good
            />
            <Metric
              label="In progress"
              href="#/deliveries?status=active"
              value={s.pending + s.delivering + s.retrying}
              detail={`${number.format(s.paused)} paused · ${number.format(s.eligible)} eligible · ${number.format(s.scheduled)} scheduled`}
              icon="deliveries"
            />
            <Metric
              label="Historical failures"
              href="#/deliveries?status=dead"
              value={s.dead}
              icon="refresh"
              warning={s.dead > 0}
            />
          </div>
          <div className="info-note overview-scope">
            <p>
              Retained delivery history across all retained time, including
              replays. The success rate is delivered / (delivered + failed);
              canceled and active deliveries are excluded. Successful replay
              recovery does not erase an earlier failure. Retention can reduce
              these counts and change the rate.
            </p>
            <p>
              Oldest eligible queued work:{' '}
              <strong>
                {s.eligible
                  ? `${number.format(s.oldest_eligible_queued_age_seconds)} seconds past its due time`
                  : 'None'}
              </strong>
              . Paused work is excluded.{' '}
              <a className="text-link" href="#/deliveries?status=canceled">
                {number.format(s.canceled)} canceled deliveries
              </a>
              .
            </p>
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
  href,
  label,
  value,
  detail,
  icon,
  good = false,
  warning = false,
}: {
  href: string;
  label: string;
  value: number;
  detail?: string;
  icon: 'events' | 'check' | 'deliveries' | 'refresh';
  good?: boolean;
  warning?: boolean;
}) {
  return (
    <a
      href={href}
      className={`metric ${good ? 'metric-good' : ''} ${warning ? 'metric-warning' : ''}`}
    >
      <div className="metric-label">
        {label}
        <Icon name={icon} size={18} />
      </div>
      <strong>{number.format(value)}</strong>
      {detail && <p>{detail}</p>}
    </a>
  );
}
export function Destinations({ notify }: Notice) {
  const { params, history, setHistory } = useListRoute('/destinations');
  const selectedID = params.get('destination_id');
  const query = useQuery(
    selectedID
      ? `/destinations/${encodeURIComponent(selectedID)}`
      : `/destinations${queryString({ limit: '25', before: history.at(-1) ?? '' })}`,
    selectedID
      ? (value) => ({ items: [destination(value)], next_cursor: null })
      : page(destination),
  );
  const [form, setForm] = useState<Destination | 'new' | null>(() =>
    window.location.hash.includes('create=true') ? 'new' : null,
  );
  const [archive, setArchive] = useState<Destination | null>(null);
  const mutation = useMutation();
  async function toggle(item: Destination) {
    const result = await mutation.run((signal) =>
      request(`/destinations/${item.id}/enabled`, destination, {
        method: 'PATCH',
        signal,
        body: JSON.stringify({
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
      {selectedID && (
        <a className="back-link" href="#/destinations">
          ← All destinations
        </a>
      )}
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
      {selectedID &&
        query.data?.items[0] &&
        (query.data.items[0].archived ? (
          <p className="info-note">
            This destination is archived. New events and replays are
            unavailable; its history remains available.
          </p>
        ) : (
          <IntegrationExample item={query.data.items[0]} />
        ))}
      {form && (
        <DestinationForm
          initial={form === 'new' ? undefined : form}
          onClose={() => setForm(null)}
          onSaved={(item) => {
            const created = form === 'new';
            setForm(null);
            notify(`Destination “${item.name}” saved.`);
            if (created)
              navigate(
                `/destinations?destination_id=${encodeURIComponent(item.id)}`,
              );
            else query.refresh();
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
            <span className="record-subtitle mono">{item.id}</span>
            <CopyButton text={item.id} label="Copy ID" />
            <a
              className="text-link"
              href={`#/guide?destination_id=${encodeURIComponent(item.id)}`}
            >
              Integration example
            </a>
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
      rowHeight={116}
      virtualized={false}
      height={Math.min((items.length + 1) * 116, 640)}
    />
  );
}
export function Deliveries() {
  const { params, history, update, setHistory } = useListRoute('/deliveries');
  const eventID = params.get('event_id') ?? '';
  const status = params.get('status') ?? '';
  const destinationID = params.get('destination_id') ?? '';
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
      <RecordLookup />
      <Panel>
        <div className="filter-bar">
          <div className="filter-field">
            <label htmlFor="delivery-status-filter">Status</label>
            <SelectField
              id="delivery-status-filter"
              aria-label="Status"
              value={status}
              onValueChange={(value) => {
                update({ status: value });
              }}
              options={[
                { value: '', label: 'All statuses' },
                { value: 'active', label: 'In progress' },
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
              update({ destination_id: value });
            }}
          />
          {eventID && (
            <span className="event-filter-label">Event {shortID(eventID)}</span>
          )}
          {(status || destinationID || eventID) && (
            <Button
              className="button small"
              onClick={() => {
                update({ status: '', event_id: '', destination_id: '' });
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
  const { params, history, update, setHistory } = useListRoute('/events');
  const destinationID = params.get('destination_id') ?? '';
  const type = params.get('type') ?? '';
  const [typeInput, setTypeInput] = useState(type);
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
    update({ type: typeInput.trim() });
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
      <RecordLookup />
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
              update({ destination_id: value });
            }}
          />
          {(type || destinationID) && (
            <Button
              className="button small"
              onClick={() => {
                update({ type: '', destination_id: '' });
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
        <a href={detailLink(`/events/${item.id}`)} className="record-link">
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
          href={detailLink(`/events/${item.id}`)}
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
      <a className="back-link" href={`#${returnRoute('/events')}`}>
        ← Back to results
      </a>
      <PageHeader
        title={data?.event.type ?? 'Event'}
        actions={<Refresh onClick={query.refresh} />}
      />
      <ErrorBox message={query.error} retry={query.refresh} />
      {query.loading && <Loading />}
      {data && (
        <>
          {data.recovered_by && <RecoveryLink id={data.recovered_by} />}
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
        navigate(
          detailLink(
            `/deliveries/${result.delivery.id}`,
            returnRoute('/deliveries'),
          ).slice(1),
        );
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
      <a className="back-link" href={`#${returnRoute('/deliveries')}`}>
        ← Back to results
      </a>
      <PageHeader
        title={`Delivery ${shortID(id)}`}
        actions={
          <>
            <Refresh onClick={query.refresh} />
            {data && (
              <Button
                className="button primary"
                onClick={() => setAction('replay')}
                disabled={!data.replay.eligible}
                aria-describedby={
                  !data.replay.eligible ? 'replay-unavailable' : undefined
                }
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
          {!data.replay.eligible && (
            <p id="replay-unavailable" className="info-note">
              {replayExplanation(data.replay.reason)}
            </p>
          )}
          {data.recovered_by && <RecoveryLink id={data.recovered_by} />}
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
                    href={detailLink(`/events/${data.delivery.event_id}`)}
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
                  <a
                    className="text-link"
                    href={`#/destinations?destination_id=${encodeURIComponent(data.destination.id)}`}
                  >
                    {data.destination.name} ·{' '}
                    {data.destination.archived
                      ? 'Archived'
                      : data.destination.enabled
                        ? 'Active'
                        : 'Paused'}
                  </a>
                </dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>
                  {data.delivery.attempt_count} of {data.max_attempts}
                </dd>
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
              <div className="detail-wide">
                <dt>Scheduling state</dt>
                <dd>{schedulingLabel(data.scheduling_state)}</dd>
              </div>
              <div>
                <dt>Scheduled due time</dt>
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
                      href={detailLink(
                        `/deliveries/${data.delivery.replay_of}`,
                      )}
                    >
                      {shortID(data.delivery.replay_of)}
                      <Icon name="arrow" size={15} />
                    </a>
                  </dd>
                </div>
              )}
            </dl>
            {data.delivery.status === 'dead' &&
              data.delivery.attempt_count >= data.max_attempts && (
                <p className="delivery-note">
                  This delivery has used its current attempt budget. Resolve the
                  failure before replaying with a fresh budget.
                </p>
              )}
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
                  : schedulingLabel(data.scheduling_state)}
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
                      <p>
                        Destination revision:{' '}
                        {item.destination_revision ??
                          'Unknown (recorded before revision tracking)'}
                      </p>
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
    network_error:
      'A network error prevented delivery. Check the receiver availability and outbound network configuration.',
    dns_error:
      'The endpoint hostname could not be resolved. Check its DNS records and the server resolver.',
    tls_error:
      'TLS verification or the secure handshake failed. Check the receiver certificate, hostname and TLS configuration.',
    destination_blocked:
      'The endpoint is blocked by the outbound network policy. Review its address and the server allowlist.',
    attempts_exhausted:
      'The delivery exhausted its attempt budget. Fix the receiver before replaying with a new budget.',
    secret_decryption_failed:
      'The signing secret could not be decrypted. Check the installation encryption key or replace this destination’s secret.',
    interrupted:
      'The worker stopped before completing this attempt. Check subsequent attempts and the current schedule; the receiver may still have accepted the event.',
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
function RecordLookup() {
  const [id, setID] = useState('');
  const [kind, setKind] = useState('deliveries');
  function open(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (id.trim())
      navigate(
        detailLink(`/${kind}/${encodeURIComponent(id.trim())}`).slice(1),
      );
  }
  return (
    <form className="filter-bar record-lookup" onSubmit={open}>
      <div className="filter-field">
        <label htmlFor="lookup-kind">Record</label>
        <SelectField
          id="lookup-kind"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: 'deliveries', label: 'Delivery ID' },
            { value: 'events', label: 'Event ID' },
          ]}
        />
      </div>
      <div className="filter-field">
        <label htmlFor="lookup-id">Full record ID</label>
        <Input
          id="lookup-id"
          value={id}
          onChange={setID}
          required
          maxLength={128}
          placeholder="Paste an event or delivery ID"
        />
      </div>
      <Button type="submit" className="button">
        Open record
      </Button>
    </form>
  );
}
function RecoveryLink({ id }: { id: string }) {
  return (
    <p className="info-note">
      Recovered by replay. The original delivery and attempts remain in history.{' '}
      <a className="text-link" href={detailLink(`/deliveries/${id}`)}>
        View successful replay <Icon name="arrow" size={15} />
      </a>
    </p>
  );
}
function replayExplanation(reason: ReplayReason): string {
  switch (reason) {
    case 'payload_redacted':
      return 'Replay unavailable: the payload was permanently redacted.';
    case 'destination_archived':
      return 'Replay unavailable: the destination is archived. Existing history is preserved.';
    case 'delivery_not_terminal':
      return 'Replay is available after this delivery finishes. Refresh to check its current state.';
    default:
      return 'Replay is currently unavailable. Refresh to check its current state.';
  }
}
function schedulingLabel(state: SchedulingState): string {
  const labels: Record<SchedulingState, string> = {
    terminal: 'Finished. No more attempts are scheduled for this delivery.',
    delivering:
      'A worker has claimed this delivery. A request may be in flight.',
    destination_archived:
      'The destination is archived; no new attempts can start.',
    waiting_for_resume:
      'Waiting for destination resume. The worker cannot claim this delivery while its destination is paused.',
    attempts_exhausted:
      'Attempt budget exhausted. No further automatic attempts are available.',
    payload_redacted:
      'The payload has been redacted; no new attempts can start.',
    scheduled:
      'Waiting for its scheduled due time before a worker can claim it.',
    unscheduled:
      'No attempt scheduled. Refresh and check the service if this persists.',
    eligible:
      'Due and eligible for a worker. Actual start depends on worker availability.',
  };
  return labels[state];
}
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }
  return (
    <>
      <Button className="button small" onClick={() => void copy()}>
        {state === 'copied' ? 'Copied' : label}
      </Button>
      {state === 'failed' && (
        <span role="status" className="field-hint">
          Clipboard unavailable. Select and copy the text above.
        </span>
      )}
    </>
  );
}
const repositoryURL = 'https://github.com/gregorsternat/hooklane/blob/main';
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
function IntegrationExample({ item }: { item?: Destination }) {
  const [key] = useState(() => crypto.randomUUID());
  const setup = `HOOKLANE_URL=${shellQuote(window.location.origin)}
HOOKLANE_INGEST_TOKEN='<INGEST_TOKEN>'
IDEMPOTENCY_KEY=${shellQuote(key)}`;
  const body = JSON.stringify(
    {
      destination_id: item?.id ?? 'YOUR_DESTINATION_ID',
      type: 'invoice.paid',
      payload: { invoice_id: 'inv_123' },
    },
    null,
    2,
  );
  const snippet = `curl --request POST "$HOOKLANE_URL/api/v1/events" \\
  --header "Authorization: Bearer $HOOKLANE_INGEST_TOKEN" \\
  --header "Idempotency-Key: $IDEMPOTENCY_KEY" \\
  --header "Content-Type: application/json" \\
  --data ${shellQuote(body)}`;
  return (
    <Panel title={item ? `Send a test event to ${item.name}` : 'Send an event'}>
      <div className="prose">
        {item && (
          <p>
            Destination ID: <code>{item.id}</code>{' '}
            <CopyButton text={item.id} label="Copy destination ID" />
          </p>
        )}
        <p>
          Run this setup once for this event. Replace the token placeholder with
          your installation’s ingestion token. The instance URL is taken from
          this console.
        </p>
        <pre className="code-block">
          <code>{setup}</code>
        </pre>
        <CopyButton text={setup} label="Copy setup" />
        <p>
          Run the request below. For retries, repeat this same request with the
          same variables and exact content. A different event requires a new
          idempotency key.
        </p>
        <pre className="code-block">
          <code>{snippet}</code>
        </pre>
        <CopyButton text={snippet} label="Copy request" />
        <p>
          Accepted events return <code>202</code>; exact duplicates return{' '}
          <code>200</code>. Find the returned delivery ID using{' '}
          <a className="text-link" href="#/deliveries">
            delivery lookup
          </a>
          , or{' '}
          <a className="text-link" href="#/events?compose=true">
            send a test from the event composer
          </a>
          .
        </p>
        {item && !item.enabled && (
          <p className="info-note">
            This destination is paused. Events can be accepted, but delivery
            waits until you resume it.
          </p>
        )}
      </div>
    </Panel>
  );
}
export function Guide() {
  const index = useDestinationIndex();
  const { params, update } = useListRoute('/guide');
  const selectedID = params.get('destination_id') ?? '';
  const selected = index.destinations.find((item) => item.id === selectedID);
  return (
    <>
      <PageHeader title="Integration guide" />
      <div className="guide-layout">
        <div>
          <Panel title="Connect your endpoint">
            <div className="prose">
              <p>
                Create a destination with a name, an HTTPS endpoint URL, and a
                signing secret of at least 32 bytes. Keep the same secret in
                your receiving application. Secrets cannot be retrieved from
                this console.
              </p>
              <p>
                Start with the{' '}
                <a
                  className="text-link"
                  href={`${repositoryURL}/examples/receiver/README.md`}
                >
                  signature-verifying receiver example
                </a>{' '}
                and follow the{' '}
                <a
                  className="text-link"
                  href={`${repositoryURL}/docs/api.md#receiving-and-verifying`}
                >
                  signing protocol
                </a>
                . Verify the exact bytes and timestamp before accepting the
                event; respond with a <code>2xx</code> status.
              </p>
              <a href="#/destinations?create=true" className="text-link">
                Create a destination <Icon name="arrow" size={16} />
              </a>
            </div>
          </Panel>
          <Panel title="Choose a destination">
            <div className="prose">
              <ErrorBox message={index.error} />
              <DestinationFilter
                value={selectedID}
                items={index.destinations.filter((item) => !item.archived)}
                onChange={(value) => update({ destination_id: value })}
              />
              {!selected && (
                <p>Choose a destination to populate its ID in the request.</p>
              )}
              {selected?.archived && (
                <p>
                  This destination is archived. Choose an active or paused
                  destination to send a new event.
                </p>
              )}
            </div>
          </Panel>
          {selected && !selected.archived && (
            <IntegrationExample key={selected.id} item={selected} />
          )}
          <Panel title="Verify and deduplicate">
            <div className="prose">
              <p>
                Deliveries are attempted at least once. Store processed
                Webhook-Id values and acknowledge known duplicates with a
                successful response. Replays keep the original Webhook-Id and
                receive a new delivery ID.
              </p>
              <p>
                Use the{' '}
                <a
                  className="text-link"
                  href={`${repositoryURL}/docs/api.md#receiving-and-verifying`}
                >
                  signature protocol
                </a>{' '}
                and{' '}
                <a
                  className="text-link"
                  href={`${repositoryURL}/examples/receiver/README.md`}
                >
                  receiver example
                </a>{' '}
                to verify signed test deliveries. The{' '}
                <a
                  className="text-link"
                  href={`${repositoryURL}/docs/operations.md`}
                >
                  operations guide
                </a>{' '}
                describes retry limits, network allowlists and retention.
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
