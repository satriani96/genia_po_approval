package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed templates/*.html templates/partials/*.html static/*
var embeddedFiles embed.FS

type Server struct {
	templates map[string]*template.Template
	netsuite  *NetSuiteClient
	
	// Cache for slow-changing data
	employeeCache     []byte
	employeeCacheTime time.Time
	locationCache     []byte
	locationCacheTime time.Time
	cacheMu           sync.RWMutex
}

const cacheDuration = 5 * time.Minute

type TemplateData struct {
	Title    string
	Active   string
	Message  string
	Requests []RequisitionLine
}

type Employee struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type ItemResult struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	SKU         string `json:"sku"`
	Description string `json:"description"`
}

type VendorOption struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	PurchasePrice float64 `json:"purchasePrice"`
}

type RequisitionItem struct {
	ItemID         string  `json:"itemId"`
	VendorID       string  `json:"vendorId,omitempty"`
	IsNewVendor    bool    `json:"isNewVendor,omitempty"`
	Quantity       float64 `json:"quantity"`
	EstimatedPrice float64 `json:"estimatedPrice,omitempty"`
	Description    string  `json:"description,omitempty"`
}

type CreateRequisitionRequest struct {
	Action      string            `json:"action"`
	RequestorID string            `json:"requestorId"`
	Subsidiary  string            `json:"subsidiary"`
	Location    string            `json:"location,omitempty"`
	Memo        string            `json:"memo,omitempty"`
	Items       []RequisitionItem `json:"items"`
}

// RequisitionLine represents a single line item from a requisition
type RequisitionLine struct {
	TranDate   string `json:"tranDate"`
	TranID     string `json:"tranId"`
	ItemName   string `json:"itemName"`
	VendorName string `json:"vendorName"`
	PONumber   string `json:"poNumber"`
}

func main() {
	_ = loadDotEnv(".env")

	templates := make(map[string]*template.Template)

	// Parse base + page templates
	templates["new"] = template.Must(template.ParseFS(embeddedFiles, "templates/base.html", "templates/new.html"))
	templates["requests"] = template.Must(template.ParseFS(embeddedFiles, "templates/base.html", "templates/requests.html"))
	templates["requests_list"] = template.Must(template.ParseFS(embeddedFiles, "templates/partials/requests_list.html"))

	client, err := NewNetSuiteClientFromEnv()
	if err != nil {
		log.Printf("NetSuite client not configured: %v", err)
	}

	server := &Server{
		templates: templates,
		netsuite:  client,
	}

	mux := http.NewServeMux()

	staticFS, err := fs.Sub(embeddedFiles, "static")
	if err != nil {
		log.Fatalf("failed to mount static files: %v", err)
	}
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

	mux.HandleFunc("/", server.handleNewRequisition)
	mux.HandleFunc("/requests", server.handleRequestsPage)

	mux.HandleFunc("/api/employees", server.handleEmployees)
	mux.HandleFunc("/api/locations", server.handleLocations)
	mux.HandleFunc("/api/items", server.handleItems)
	mux.HandleFunc("/api/item-vendors", server.handleItemVendors)
	mux.HandleFunc("/api/vendors", server.handleVendors)
	mux.HandleFunc("/api/requisitions", server.handleCreateRequisition)
	mux.HandleFunc("/api/requests", server.handleRequests)

	addr := ":8080"
	if port := os.Getenv("PORT"); port != "" {
		addr = ":" + port
	}

	log.Printf("listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func loadDotEnv(filename string) error {
	data, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		value = strings.Trim(value, `"'`)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, value)
		}
	}
	return nil
}

func (s *Server) handleNewRequisition(w http.ResponseWriter, r *http.Request) {
	data := TemplateData{
		Title:  "New Requisition",
		Active: "new",
	}
	s.renderPage(w, "new", data)
}

func (s *Server) handleRequestsPage(w http.ResponseWriter, r *http.Request) {
	data := TemplateData{
		Title:  "My Requests",
		Active: "requests",
	}
	s.renderPage(w, "requests", data)
}

func (s *Server) handleEmployees(w http.ResponseWriter, r *http.Request) {
	if s.netsuite == nil {
		writeError(w, http.StatusServiceUnavailable, "NetSuite restlet is not configured yet.")
		return
	}

	// Check cache first
	s.cacheMu.RLock()
	if s.employeeCache != nil && time.Since(s.employeeCacheTime) < cacheDuration {
		data := s.employeeCache
		s.cacheMu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
		return
	}
	s.cacheMu.RUnlock()

	payload, err := s.netsuite.Call(r.Context(), http.MethodGet, map[string]string{
		"action": "employees",
	}, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	// Update cache
	s.cacheMu.Lock()
	s.employeeCache = payload
	s.employeeCacheTime = time.Now()
	s.cacheMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

func (s *Server) handleLocations(w http.ResponseWriter, r *http.Request) {
	if s.netsuite == nil {
		writeError(w, http.StatusServiceUnavailable, "NetSuite restlet is not configured yet.")
		return
	}

	// Check cache first
	s.cacheMu.RLock()
	if s.locationCache != nil && time.Since(s.locationCacheTime) < cacheDuration {
		data := s.locationCache
		s.cacheMu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
		return
	}
	s.cacheMu.RUnlock()

	payload, err := s.netsuite.Call(r.Context(), http.MethodGet, map[string]string{
		"action": "locations",
	}, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	// Update cache
	s.cacheMu.Lock()
	s.locationCache = payload
	s.locationCacheTime = time.Now()
	s.cacheMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

func (s *Server) handleItems(w http.ResponseWriter, r *http.Request) {
	if s.netsuite == nil {
		writeError(w, http.StatusServiceUnavailable, "NetSuite restlet is not configured yet.")
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
		return
	}

	payload, err := s.netsuite.Call(r.Context(), http.MethodGet, map[string]string{
		"action": "items",
		"q":      query,
	}, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

func (s *Server) handleItemVendors(w http.ResponseWriter, r *http.Request) {
	if s.netsuite == nil {
		writeError(w, http.StatusServiceUnavailable, "NetSuite restlet is not configured yet.")
		return
	}

	itemID := strings.TrimSpace(r.URL.Query().Get("itemId"))
	if itemID == "" {
		writeError(w, http.StatusBadRequest, "itemId is required")
		return
	}

	payload, err := s.netsuite.Call(r.Context(), http.MethodGet, map[string]string{
		"action": "itemVendors",
		"itemId": itemID,
	}, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

func (s *Server) handleVendors(w http.ResponseWriter, r *http.Request) {
	if s.netsuite == nil {
		writeError(w, http.StatusServiceUnavailable, "NetSuite restlet is not configured yet.")
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
		return
	}

	payload, err := s.netsuite.Call(r.Context(), http.MethodGet, map[string]string{
		"action": "vendors",
		"q":      query,
	}, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

func (s *Server) handleCreateRequisition(w http.ResponseWriter, r *http.Request) {
	if s.netsuite == nil {
		writeError(w, http.StatusServiceUnavailable, "NetSuite restlet is not configured yet.")
		return
	}

	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid form submission")
		return
	}

	var items []RequisitionItem
	itemsJSON := r.FormValue("itemsJson")
	if itemsJSON != "" {
		if err := json.Unmarshal([]byte(itemsJSON), &items); err != nil {
			writeError(w, http.StatusBadRequest, "invalid items list")
			return
		}
	}

	req := CreateRequisitionRequest{
		Action:      "createRequisition",
		RequestorID: strings.TrimSpace(r.FormValue("requestorId")),
		Subsidiary:  strings.TrimSpace(r.FormValue("subsidiary")),
		Location:    strings.TrimSpace(r.FormValue("location")),
		Memo:        strings.TrimSpace(r.FormValue("notes")),
		Items:       items,
	}

	if req.RequestorID == "" {
		writeError(w, http.StatusBadRequest, "select your name first")
		return
	}
	if req.Subsidiary == "" {
		writeError(w, http.StatusBadRequest, "subsidiary is required")
		return
	}
	if len(req.Items) == 0 {
		writeError(w, http.StatusBadRequest, "add at least one item")
		return
	}

	payload, err := s.netsuite.Call(r.Context(), http.MethodPost, nil, req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	var response struct {
		ID     string `json:"id"`
		TranID string `json:"tranId"`
	}
	_ = json.Unmarshal(payload, &response)

	message := "Requisition submitted."
	if response.TranID != "" {
		message = fmt.Sprintf("Requisition %s submitted.", response.TranID)
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.WriteString(w, fmt.Sprintf(`<div class="status status-success">%s</div>`, template.HTMLEscapeString(message)))
}

func (s *Server) handleRequests(w http.ResponseWriter, r *http.Request) {
	if s.netsuite == nil {
		writeError(w, http.StatusServiceUnavailable, "NetSuite restlet is not configured yet.")
		return
	}

	employeeID := strings.TrimSpace(r.URL.Query().Get("employeeId"))
	if employeeID == "" {
		writeError(w, http.StatusBadRequest, "employeeId is required")
		return
	}

	payload, err := s.netsuite.Call(r.Context(), http.MethodGet, map[string]string{
		"action":     "requests",
		"employeeId": employeeID,
	}, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	var lines []RequisitionLine
	if err := json.Unmarshal(payload, &lines); err != nil {
		log.Printf("JSON unmarshal error: %v, payload: %s", err, string(payload[:min(500, len(payload))]))
		writeError(w, http.StatusBadGateway, "invalid response from NetSuite")
		return
	}

	s.renderPartial(w, "requests_list", TemplateData{Requests: lines})
}

func (s *Server) renderPage(w http.ResponseWriter, name string, data TemplateData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	tmpl, ok := s.templates[name]
	if !ok {
		http.Error(w, "template not found", http.StatusInternalServerError)
		return
	}
	if err := tmpl.ExecuteTemplate(w, "base", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) renderPartial(w http.ResponseWriter, name string, data TemplateData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	tmpl, ok := s.templates[name]
	if !ok {
		http.Error(w, "template not found", http.StatusInternalServerError)
		return
	}
	if err := tmpl.ExecuteTemplate(w, name, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func statusToClass(status string) string {
	s := strings.ToLower(status)
	switch {
	case strings.Contains(s, "approved"):
		return "badge-approved"
	case strings.Contains(s, "converted"), strings.Contains(s, "closed"), strings.Contains(s, "ordered"):
		return "badge-converted"
	default:
		return "badge-pending"
	}
}


func writeError(w http.ResponseWriter, status int, message string) {
	w.WriteHeader(status)
	io.WriteString(w, fmt.Sprintf(`<div class="status status-error">%s</div>`, template.HTMLEscapeString(message)))
}

type NetSuiteClient struct {
	accountID      string
	realm          string
	consumerKey    string
	consumerSecret string
	tokenID        string
	tokenSecret    string
	restletURL     *url.URL
	httpClient     *http.Client
}

func NewNetSuiteClientFromEnv() (*NetSuiteClient, error) {
	accountID := os.Getenv("NETSUITE_ACCOUNT_ID")
	realm := os.Getenv("NETSUITE_REALM")
	consumerKey := os.Getenv("NETSUITE_CONSUMER_KEY")
	consumerSecret := os.Getenv("NETSUITE_CONSUMER_SECRET")
	tokenID := os.Getenv("NETSUITE_TOKEN_ID")
	tokenSecret := os.Getenv("NETSUITE_TOKEN_SECRET")
	restletURL := os.Getenv("NETSUITE_RESTLET_URL")

	if restletURL == "" {
		return nil, errors.New("NETSUITE_RESTLET_URL is not set")
	}

	parsedURL, err := url.Parse(restletURL)
	if err != nil {
		return nil, fmt.Errorf("invalid NETSUITE_RESTLET_URL: %w", err)
	}

	if accountID == "" || consumerKey == "" || consumerSecret == "" || tokenID == "" || tokenSecret == "" {
		return nil, errors.New("NetSuite OAuth credentials are missing")
	}

	if realm == "" {
		realm = accountID
	}

	return &NetSuiteClient{
		accountID:      accountID,
		realm:          realm,
		consumerKey:    consumerKey,
		consumerSecret: consumerSecret,
		tokenID:        tokenID,
		tokenSecret:    tokenSecret,
		restletURL:     parsedURL,
		httpClient:     &http.Client{Timeout: 20 * time.Second},
	}, nil
}

func (c *NetSuiteClient) Call(ctx context.Context, method string, params map[string]string, body interface{}) ([]byte, error) {
	if c == nil {
		return nil, errors.New("netsuite client is not configured")
	}

	urlCopy := *c.restletURL
	query := urlCopy.Query()
	for key, value := range params {
		query.Set(key, value)
	}
	urlCopy.RawQuery = query.Encode()

	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}

	req, err := http.NewRequestWithContext(ctx, method, urlCopy.String(), strings.NewReader(string(payload)))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", c.oauthHeader(method, &urlCopy, payload))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		log.Printf("NetSuite error: status=%d url=%s response=%s", resp.StatusCode, urlCopy.String(), strings.TrimSpace(string(responseBody)))
		return nil, fmt.Errorf("NetSuite error (%d): %s", resp.StatusCode, strings.TrimSpace(string(responseBody)))
	}

	log.Printf("NetSuite success: action=%s items=%d", params["action"], len(responseBody))
	return responseBody, nil
}

func (c *NetSuiteClient) oauthHeader(method string, requestURL *url.URL, body []byte) string {
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	nonce := randomNonce(32)

	oauthParams := map[string]string{
		"oauth_consumer_key":     c.consumerKey,
		"oauth_token":            c.tokenID,
		"oauth_signature_method": "HMAC-SHA256",
		"oauth_timestamp":        timestamp,
		"oauth_nonce":            nonce,
		"oauth_version":          "1.0",
	}

	baseURL := *requestURL
	baseURL.RawQuery = ""
	baseURL.Fragment = ""
	baseURL.Path = path.Clean(baseURL.Path)

	signature := c.buildSignature(method, &baseURL, requestURL.Query(), oauthParams)
	oauthParams["oauth_signature"] = signature

	keys := make([]string, 0, len(oauthParams))
	for key := range oauthParams {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var headerParts []string
	headerParts = append(headerParts, fmt.Sprintf(`realm="%s"`, oauthEncode(c.realm)))
	for _, key := range keys {
		headerParts = append(headerParts, fmt.Sprintf(`%s="%s"`, oauthEncode(key), oauthEncode(oauthParams[key])))
	}
	return "OAuth " + strings.Join(headerParts, ", ")
}

func (c *NetSuiteClient) buildSignature(method string, baseURL *url.URL, query url.Values, oauthParams map[string]string) string {
	type pair struct {
		key   string
		value string
	}
	var pairs []pair

	for key, values := range query {
		for _, value := range values {
			pairs = append(pairs, pair{key: key, value: value})
		}
	}
	for key, value := range oauthParams {
		pairs = append(pairs, pair{key: key, value: value})
	}

	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].key == pairs[j].key {
			return pairs[i].value < pairs[j].value
		}
		return pairs[i].key < pairs[j].key
	})

	var paramParts []string
	for _, p := range pairs {
		paramParts = append(paramParts, fmt.Sprintf("%s=%s", oauthEncode(p.key), oauthEncode(p.value)))
	}

	paramString := strings.Join(paramParts, "&")
	base := strings.ToUpper(method) + "&" + oauthEncode(baseURL.String()) + "&" + oauthEncode(paramString)

	signingKey := oauthEncode(c.consumerSecret) + "&" + oauthEncode(c.tokenSecret)
	h := hmac.New(sha256.New, []byte(signingKey))
	h.Write([]byte(base))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func oauthEncode(value string) string {
	var builder strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '.' || r == '_' || r == '~' {
			builder.WriteRune(r)
		} else {
			bytes := []byte(string(r))
			for _, b := range bytes {
				builder.WriteString(fmt.Sprintf("%%%02X", b))
			}
		}
	}
	return builder.String()
}

func randomNonce(length int) string {
	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	var result strings.Builder
	for i := 0; i < length; i++ {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		result.WriteByte(letters[n.Int64()])
	}
	return result.String()
}
