package purchase

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/pickket/ticket-gateway/internal/middleware"

	"github.com/go-chi/chi/v5"
)

type Handler struct {
	service *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

type PurchaseHTTPRequest struct {
	SeatID   string `json:"seat_id,omitempty"`
	Quantity int    `json:"quantity"`
}

// HandlePurchase is the HTTP handler for POST /api/v1/{eventId}/tiers/{tierId}/purchase
// Auth middleware has already validated JWT and set user_id in context.
// Rate limit middleware has already checked purchase rate limits.
func (h *Handler) HandlePurchase(w http.ResponseWriter, r *http.Request) {
	eventID := chi.URLParam(r, "eventId")
	tierID := chi.URLParam(r, "tierId")

	userID, ok := middleware.UserIDFromContext(r.Context())
	if !ok || userID == "" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	var req PurchaseHTTPRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	quantity := req.Quantity
	if quantity <= 0 {
		quantity = 1
	}

	result, err := h.service.ProcessPurchase(r.Context(), PurchaseRequest{
		EventID:  eventID,
		TierID:   tierID,
		UserID:   userID,
		SeatID:   req.SeatID,
		Quantity: quantity,
	})
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"%s"}`, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")

	switch result.Status {
	case "HELD":
		w.WriteHeader(http.StatusOK)
	case "sold_out":
		w.WriteHeader(http.StatusConflict)
	case "seat_unavailable":
		w.WriteHeader(http.StatusConflict)
	default:
		w.WriteHeader(http.StatusOK)
	}

	json.NewEncoder(w).Encode(result)
}
