package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/gregorsternat/hooklane/internal/store"
)

// Options configures the authenticated HTTP boundary. Tokens are never returned.
type Options struct {
	AdminToken      string
	IngestToken     string
	SecureCookies   bool
	MaxPayloadBytes int64
	ValidateURL     func(context.Context, string) error
	Ready           func() bool
}

// backend is the persistence boundary used by HTTP handlers.
type backend interface {
	CreateDestination(context.Context, store.DestinationInput) (store.Destination, error)
	UpdateDestination(context.Context, string, store.DestinationInput) (store.Destination, error)
	SetDestinationEnabled(context.Context, string, bool) (store.Destination, error)
	ArchiveDestination(context.Context, string) error
	GetDestination(context.Context, string) (store.Destination, error)
	ListDestinations(context.Context, store.Page) ([]store.Destination, error)
	Ingest(context.Context, store.IngestInput) (store.IngestResult, error)
	ListEvents(context.Context, store.EventFilter) ([]store.Event, error)
	GetEvent(context.Context, string) (store.EventDetail, error)
	ListDeliveries(context.Context, store.DeliveryFilter) ([]store.Delivery, error)
	GetDelivery(context.Context, string) (store.DeliveryDetail, error)
	Replay(context.Context, string, string) (store.Delivery, bool, error)
	Cancel(context.Context, string) error
	Redact(context.Context, string) error
	Stats(context.Context) (store.Stats, error)
}

type api struct {
	store   backend
	options Options
	login   *loginLimiter
}

// NewAPIHandler serves authenticated v1 routes alongside health and static files.
func NewAPIHandler(ping func(context.Context) error, readinessTimeout time.Duration, webDir string, s *store.Store, options Options) http.Handler {
	var b backend
	if s != nil {
		b = s
	}
	return newAPIHandler(ping, readinessTimeout, webDir, b, options)
}

func newAPIHandler(ping func(context.Context) error, readinessTimeout time.Duration, webDir string, b backend, options Options) http.Handler {
	if options.MaxPayloadBytes <= 0 {
		options.MaxPayloadBytes = 1024 * 1024
	}
	a := &api{store: b, options: options, login: newLoginLimiter()}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/session", a.createSession)
	mux.Handle("GET /api/v1/session", a.authorize(false, false, http.HandlerFunc(a.session)))
	mux.Handle("DELETE /api/v1/session", a.authorize(false, false, http.HandlerFunc(a.deleteSession)))

	routes := []struct {
		pattern string
		ingest  bool
		handler http.HandlerFunc
	}{
		{"POST /api/v1/destinations", false, a.createDestination},
		{"GET /api/v1/destinations", false, a.listDestinations},
		{"GET /api/v1/destinations/{id}", false, a.getDestination},
		{"PUT /api/v1/destinations/{id}", false, a.updateDestination},
		{"PATCH /api/v1/destinations/{id}/enabled", false, a.setDestinationEnabled},
		{"DELETE /api/v1/destinations/{id}", false, a.archiveDestination},
		{"POST /api/v1/events", true, a.ingest},
		{"GET /api/v1/events", false, a.listEvents},
		{"GET /api/v1/events/{id}", false, a.getEvent},
		{"DELETE /api/v1/events/{id}/payload", false, a.redact},
		{"GET /api/v1/deliveries", false, a.listDeliveries},
		{"GET /api/v1/deliveries/{id}", false, a.getDelivery},
		{"POST /api/v1/deliveries/{id}/replay", false, a.replay},
		{"POST /api/v1/deliveries/{id}/cancel", false, a.cancel},
		{"GET /api/v1/stats", false, a.stats},
		{"GET /api/v1/metrics", false, a.metrics},
	}
	for _, route := range routes {
		mux.Handle(route.pattern, a.authorize(route.ingest, true, route.handler))
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		apiError(w, http.StatusNotFound, "not_found", "API route not found.")
	})
	mux.Handle("/", NewHandler(ping, readinessTimeout, webDir))
	return securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
			defer cancel()
			r = r.WithContext(ctx)
		}
		mux.ServeHTTP(w, r)
	}))
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

func respond(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func apiError(w http.ResponseWriter, status int, code, message string) {
	respond(w, status, struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}})
}

func storeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		apiError(w, http.StatusNotFound, "not_found", "The requested resource was not found.")
	case errors.Is(err, store.ErrDestinationConflict):
		apiError(w, http.StatusPreconditionFailed, "destination_conflict", "The destination changed after you opened it. Reload the current configuration before saving your edits.")
	case errors.Is(err, store.ErrPayloadRedacted):
		apiError(w, http.StatusConflict, "payload_redacted", "The event payload was permanently redacted and cannot be replayed.")
	case errors.Is(err, store.ErrDeliveryNotTerminal):
		apiError(w, http.StatusConflict, "delivery_not_terminal", "This delivery is still active. Refresh to check its latest state before replaying.")
	case errors.Is(err, store.ErrConflict):
		apiError(w, http.StatusConflict, "conflict", "The request conflicts with existing data or the current resource state.")
	case errors.Is(err, store.ErrUnavailable):
		apiError(w, http.StatusConflict, "destination_unavailable", "The destination is archived or unavailable.")
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		apiError(w, http.StatusServiceUnavailable, "unavailable", "The operation timed out. Try again with the same idempotency key.")
	default:
		apiError(w, http.StatusServiceUnavailable, "unavailable", "The service is temporarily unavailable.")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		apiError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json.")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	defer func() { _ = r.Body.Close() }()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		bodyError(w, err)
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		bodyError(w, err)
		return false
	}
	return true
}

func bodyError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		apiError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "The request exceeds the configured size limit.")
		return
	}
	apiError(w, http.StatusBadRequest, "invalid_json", "Provide exactly one valid JSON object with supported fields.")
}

func resourceID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !validID(id) {
		apiError(w, http.StatusBadRequest, "invalid_id", "Provide a valid resource identifier.")
		return "", false
	}
	return id, true
}

func validID(id string) bool {
	if len(id) != 40 || id[3] != '_' || (id[:3] != "dst" && id[:3] != "evt" && id[:3] != "dlv") {
		return false
	}
	for _, ch := range id[4:] {
		isHex := ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f'
		if !isHex {
			return false
		}
	}
	return true
}

func pageQuery(w http.ResponseWriter, r *http.Request) (store.Page, bool) {
	page := store.Page{Limit: 25, Before: r.URL.Query().Get("before")}
	if value := r.URL.Query().Get("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			apiError(w, http.StatusBadRequest, "invalid_pagination", "limit must be between 1 and 100.")
			return page, false
		}
		page.Limit = limit
	}
	if page.Before != "" && !validID(page.Before) {
		apiError(w, http.StatusBadRequest, "invalid_pagination", "before must be a resource identifier returned by next_cursor.")
		return page, false
	}
	return page, true
}

func optionalID(w http.ResponseWriter, id string) bool {
	if id != "" && !validID(id) {
		apiError(w, http.StatusBadRequest, "invalid_filter", "Provide a valid resource identifier in filters.")
		return false
	}
	return true
}

func listResponse[T any](w http.ResponseWriter, items []T, limit int, id func(T) string) {
	var cursor *string
	if len(items) > limit {
		value := id(items[limit-1])
		cursor = &value
		items = items[:limit]
	}
	if items == nil {
		items = []T{}
	}
	respond(w, http.StatusOK, struct {
		Items      []T     `json:"items"`
		NextCursor *string `json:"next_cursor"`
	}{Items: items, NextCursor: cursor})
}

func (a *api) destinationInput(w http.ResponseWriter, r *http.Request, existing *store.Destination) (store.DestinationInput, bool) {
	var body struct {
		Name          string `json:"name"`
		URL           string `json:"url"`
		SigningSecret string `json:"signing_secret"`
		Enabled       *bool  `json:"enabled"`
	}
	if !decodeJSON(w, r, 16*1024, &body) {
		return store.DestinationInput{}, false
	}
	body.Name = strings.TrimSpace(body.Name)
	parsed, err := url.Parse(body.URL)
	if len(body.Name) < 1 || len(body.Name) > 120 || strings.ContainsFunc(body.Name, unicode.IsControl) {
		apiError(w, http.StatusBadRequest, "invalid_destination", "name must contain 1 to 120 characters without control characters.")
		return store.DestinationInput{}, false
	}
	if len(body.URL) > 2048 || err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		apiError(w, http.StatusBadRequest, "invalid_destination", "url must be an HTTP or HTTPS URL without credentials, query parameters, or fragments.")
		return store.DestinationInput{}, false
	}
	if (existing == nil || body.SigningSecret != "") && (len(body.SigningSecret) < 32 || len(body.SigningSecret) > 512 || strings.ContainsFunc(body.SigningSecret, unicode.IsControl)) {
		apiError(w, http.StatusBadRequest, "invalid_destination", "signing_secret must contain 32 to 512 characters without control characters.")
		return store.DestinationInput{}, false
	}
	// Existing destinations must remain pausable and editable during DNS outages.
	// The delivery transport independently validates DNS on every outbound request.
	if existing == nil || body.URL != existing.URL {
		if a.options.ValidateURL == nil {
			apiError(w, http.StatusServiceUnavailable, "unavailable", "Destination validation is unavailable.")
			return store.DestinationInput{}, false
		}
		if err := a.options.ValidateURL(r.Context(), body.URL); err != nil {
			apiError(w, http.StatusBadRequest, "destination_blocked", "Use HTTPS and a public hostname. HTTP and private-network destinations require explicit server configuration; the host must resolve.")
			return store.DestinationInput{}, false
		}
	}
	enabled := true
	if existing != nil {
		enabled = existing.Enabled
	}
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	return store.DestinationInput{Name: body.Name, URL: body.URL, SigningSecret: body.SigningSecret, Enabled: enabled}, true
}

func (a *api) createDestination(w http.ResponseWriter, r *http.Request) {
	input, ok := a.destinationInput(w, r, nil)
	if !ok {
		return
	}
	destination, err := a.store.CreateDestination(r.Context(), input)
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("ETag", fmt.Sprintf(`"%d"`, destination.Revision))
	w.Header().Set("Location", "/api/v1/destinations/"+destination.ID)
	respond(w, http.StatusCreated, destination)
}

func (a *api) updateDestination(w http.ResponseWriter, r *http.Request) {
	id, ok := resourceID(w, r)
	if !ok {
		return
	}
	value := r.Header.Get("If-Match")
	if value == "" {
		apiError(w, http.StatusPreconditionRequired, "precondition_required", "Send If-Match with the quoted revision from the destination you edited.")
		return
	}
	revision, err := strconv.ParseInt(strings.Trim(value, `"`), 10, 64)
	if err != nil || revision < 1 || value != fmt.Sprintf(`"%d"`, revision) {
		apiError(w, http.StatusBadRequest, "invalid_precondition", "If-Match must contain one quoted positive destination revision.")
		return
	}
	existing, err := a.store.GetDestination(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	if existing.Revision != revision {
		storeError(w, store.ErrDestinationConflict)
		return
	}
	input, ok := a.destinationInput(w, r, &existing)
	if !ok {
		return
	}
	input.Revision = revision
	destination, err := a.store.UpdateDestination(r.Context(), id, input)
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("ETag", fmt.Sprintf(`"%d"`, destination.Revision))
	respond(w, http.StatusOK, destination)
}

func (a *api) setDestinationEnabled(w http.ResponseWriter, r *http.Request) {
	id, ok := resourceID(w, r)
	if !ok {
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeJSON(w, r, 1024, &body) {
		return
	}
	if body.Enabled == nil {
		apiError(w, http.StatusBadRequest, "invalid_destination", "enabled must be a boolean.")
		return
	}
	destination, err := a.store.SetDestinationEnabled(r.Context(), id, *body.Enabled)
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("ETag", fmt.Sprintf(`"%d"`, destination.Revision))
	respond(w, http.StatusOK, destination)
}

func (a *api) listDestinations(w http.ResponseWriter, r *http.Request) {
	page, ok := pageQuery(w, r)
	if !ok {
		return
	}
	limit := page.Limit
	page.Limit++
	destinations, err := a.store.ListDestinations(r.Context(), page)
	if err != nil {
		storeError(w, err)
		return
	}
	listResponse(w, destinations, limit, func(d store.Destination) string { return d.ID })
}

func (a *api) getDestination(w http.ResponseWriter, r *http.Request) {
	id, ok := resourceID(w, r)
	if !ok {
		return
	}
	destination, err := a.store.GetDestination(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("ETag", fmt.Sprintf(`"%d"`, destination.Revision))
	respond(w, http.StatusOK, destination)
}

func (a *api) archiveDestination(w http.ResponseWriter, r *http.Request) {
	id, ok := resourceID(w, r)
	if !ok {
		return
	}
	if err := a.store.ArchiveDestination(r.Context(), id); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func visibleASCII(value string) bool {
	for _, ch := range value {
		if ch < 33 || ch > 126 {
			return false
		}
	}
	return true
}

func idempotencyKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	key := r.Header.Get("Idempotency-Key")
	if len(key) < 1 || len(key) > 128 {
		apiError(w, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key is required and must contain 1 to 128 visible ASCII characters.")
		return "", false
	}
	for _, ch := range key {
		if ch < 33 || ch > 126 {
			apiError(w, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key is required and must contain 1 to 128 visible ASCII characters.")
			return "", false
		}
	}
	return key, true
}

func (a *api) ingest(w http.ResponseWriter, r *http.Request) {
	key, ok := idempotencyKey(w, r)
	if !ok {
		return
	}
	var body struct {
		DestinationID string          `json:"destination_id"`
		Type          string          `json:"type"`
		Payload       json.RawMessage `json:"payload"`
	}
	if !decodeJSON(w, r, a.options.MaxPayloadBytes+16*1024, &body) {
		return
	}
	if !validID(body.DestinationID) || len(body.Type) < 1 || len(body.Type) > 120 || !visibleASCII(body.Type) || len(body.Payload) == 0 {
		apiError(w, http.StatusBadRequest, "invalid_event", "Provide destination_id, type (1 to 120 characters), and a JSON payload.")
		return
	}
	if int64(len(body.Payload)) > a.options.MaxPayloadBytes {
		apiError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "The payload exceeds the configured size limit.")
		return
	}
	result, err := a.store.Ingest(r.Context(), store.IngestInput{DestinationID: body.DestinationID, Type: body.Type, IdempotencyKey: key, Payload: body.Payload})
	if err != nil {
		storeError(w, err)
		return
	}
	code := http.StatusAccepted
	if result.Duplicate {
		code = http.StatusOK
	}
	w.Header().Set("Location", "/api/v1/events/"+result.Event.ID)
	respond(w, code, result)
}

func (a *api) listEvents(w http.ResponseWriter, r *http.Request) {
	page, ok := pageQuery(w, r)
	if !ok {
		return
	}
	filter := store.EventFilter{Page: page, DestinationID: r.URL.Query().Get("destination_id"), Type: r.URL.Query().Get("type")}
	if !optionalID(w, filter.DestinationID) {
		return
	}
	if len(filter.Type) > 120 || strings.ContainsFunc(filter.Type, unicode.IsControl) {
		apiError(w, http.StatusBadRequest, "invalid_filter", "type must contain at most 120 characters without control characters.")
		return
	}
	filter.Limit++
	events, err := a.store.ListEvents(r.Context(), filter)
	if err != nil {
		storeError(w, err)
		return
	}
	listResponse(w, events, page.Limit, func(e store.Event) string { return e.ID })
}

func (a *api) getEvent(w http.ResponseWriter, r *http.Request) {
	id, ok := resourceID(w, r)
	if !ok {
		return
	}
	event, err := a.store.GetEvent(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	if event.Deliveries == nil {
		event.Deliveries = []store.Delivery{}
	}
	respond(w, http.StatusOK, event)
}

func (a *api) redact(w http.ResponseWriter, r *http.Request) {
	id, ok := resourceID(w, r)
	if !ok {
		return
	}
	if err := a.store.Redact(r.Context(), id); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) listDeliveries(w http.ResponseWriter, r *http.Request) {
	page, ok := pageQuery(w, r)
	if !ok {
		return
	}
	filter := store.DeliveryFilter{Page: page, DestinationID: r.URL.Query().Get("destination_id"), EventID: r.URL.Query().Get("event_id"), Status: r.URL.Query().Get("status")}
	if !optionalID(w, filter.DestinationID) || !optionalID(w, filter.EventID) {
		return
	}
	switch filter.Status {
	case "", "active", "pending", "retrying", "delivering", "succeeded", "dead", "canceled":
	default:
		apiError(w, http.StatusBadRequest, "invalid_filter", "status must be active, pending, retrying, delivering, succeeded, dead, or canceled.")
		return
	}
	filter.Limit++
	deliveries, err := a.store.ListDeliveries(r.Context(), filter)
	if err != nil {
		storeError(w, err)
		return
	}
	listResponse(w, deliveries, page.Limit, func(d store.Delivery) string { return d.ID })
}

func (a *api) getDelivery(w http.ResponseWriter, r *http.Request) {
	id, ok := resourceID(w, r)
	if !ok {
		return
	}
	delivery, err := a.store.GetDelivery(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	if delivery.Attempts == nil {
		delivery.Attempts = []store.Attempt{}
	}
	respond(w, http.StatusOK, delivery)
}

func (a *api) replay(w http.ResponseWriter, r *http.Request) {
	id, ok := resourceID(w, r)
	if !ok {
		return
	}
	key, ok := idempotencyKey(w, r)
	if !ok {
		return
	}
	delivery, duplicate, err := a.store.Replay(r.Context(), id, key)
	if err != nil {
		storeError(w, err)
		return
	}
	code := http.StatusAccepted
	if duplicate {
		code = http.StatusOK
	}
	respond(w, code, struct {
		Delivery  store.Delivery `json:"delivery"`
		Duplicate bool           `json:"duplicate"`
	}{Delivery: delivery, Duplicate: duplicate})
}

func (a *api) cancel(w http.ResponseWriter, r *http.Request) {
	id, ok := resourceID(w, r)
	if !ok {
		return
	}
	if err := a.store.Cancel(r.Context(), id); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) stats(w http.ResponseWriter, r *http.Request) {
	stats, err := a.store.Stats(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	respond(w, http.StatusOK, stats)
}

func (a *api) metrics(w http.ResponseWriter, r *http.Request) {
	stats, err := a.store.Stats(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = fmt.Fprintf(w, "# HELP hooklane_destinations Configured destinations excluding archived destinations.\n# TYPE hooklane_destinations gauge\nhooklane_destinations %d\n# HELP hooklane_events Retained event metadata records.\n# TYPE hooklane_events gauge\nhooklane_events %d\n# HELP hooklane_deliveries Delivery records by current state.\n# TYPE hooklane_deliveries gauge\nhooklane_deliveries{status=\"pending\"} %d\nhooklane_deliveries{status=\"retrying\"} %d\nhooklane_deliveries{status=\"delivering\"} %d\nhooklane_deliveries{status=\"succeeded\"} %d\nhooklane_deliveries{status=\"dead\"} %d\nhooklane_deliveries{status=\"canceled\"} %d\n", stats.Destinations, stats.Events, stats.Pending, stats.Retrying, stats.Delivering, stats.Succeeded, stats.Dead, stats.Canceled)
	_, _ = fmt.Fprintf(w, "# HELP hooklane_queued_deliveries Queued retained deliveries by scheduling state under the configured attempt budget.\n# TYPE hooklane_queued_deliveries gauge\nhooklane_queued_deliveries{state=\"paused\"} %d\nhooklane_queued_deliveries{state=\"eligible\"} %d\nhooklane_queued_deliveries{state=\"scheduled\"} %d\n# HELP hooklane_oldest_eligible_queued_age_seconds Time past due for the oldest worker-eligible queued delivery; zero when none.\n# TYPE hooklane_oldest_eligible_queued_age_seconds gauge\nhooklane_oldest_eligible_queued_age_seconds %g\n", stats.Paused, stats.Eligible, stats.Scheduled, stats.OldestEligibleQueuedAgeSeconds)
}
