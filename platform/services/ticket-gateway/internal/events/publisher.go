package events

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	snstypes "github.com/aws/aws-sdk-go-v2/service/sns/types"
	"github.com/pickket/ticket-gateway/internal/config"
)

// envelope wraps every SNS message so the Python SQS consumer
// can extract event_type without relying on SNS Subject.
type envelope struct {
	EventType string      `json:"event_type"`
	Timestamp string      `json:"timestamp"`
	Source    string      `json:"source"`
	Data      interface{} `json:"data"`
}

func newEnvelope(eventType string, data interface{}) envelope {
	return envelope{
		EventType: eventType,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Source:    "ticket-gateway",
		Data:      data,
	}
}

type Publisher struct {
	client         *sns.Client
	topicPurchase  string
	topicSeatHold  string
	topicAdmission string
	enabled        bool
}

func NewPublisher(cfg *config.Config) *Publisher {
	p := &Publisher{
		topicPurchase:  cfg.SNSTopicPurchase,
		topicSeatHold:  cfg.SNSTopicSeatHold,
		topicAdmission: cfg.SNSTopicAdmission,
	}

	// Only enable SNS if at least one topic ARN is configured
	if cfg.SNSTopicPurchase == "" && cfg.SNSTopicSeatHold == "" && cfg.SNSTopicAdmission == "" {
		log.Println("[SNS] No topic ARNs configured, publisher disabled")
		p.enabled = false
		return p
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion(cfg.SNSRegion),
	)
	if err != nil {
		log.Printf("[SNS] Failed to load AWS config: %v — publisher disabled", err)
		p.enabled = false
		return p
	}

	p.client = sns.NewFromConfig(awsCfg)
	p.enabled = true
	log.Printf("[SNS] Publisher initialized (region=%s)", cfg.SNSRegion)
	return p
}

type PurchaseEvent struct {
	EventID  string `json:"event_id"`
	TierID   string `json:"tier_id"`
	UserID   string `json:"user_id"`
	SeatID   string `json:"seat_id,omitempty"`
	OrderID  string `json:"order_id,omitempty"`
	Quantity int    `json:"quantity,omitempty"`
	Amount   int    `json:"amount,omitempty"`
	Status   string `json:"status"`
}

type SeatHoldEvent struct {
	EventID string `json:"event_id"`
	SeatID  string `json:"seat_id"`
	UserID  string `json:"user_id"`
	HoldTTL int    `json:"hold_ttl,omitempty"`
	Action  string `json:"action"` // "hold" or "release"
}

// PublishPurchaseAsync publishes a purchase event to SNS in a goroutine.
func (p *Publisher) PublishPurchaseAsync(event PurchaseEvent) {
	if !p.enabled || p.topicPurchase == "" {
		return
	}
	go func() {
		env := newEnvelope("order.created", event)
		data, err := json.Marshal(env)
		if err != nil {
			log.Printf("[SNS] Failed to marshal purchase event: %v", err)
			return
		}
		_, err = p.client.Publish(context.Background(), &sns.PublishInput{
			TopicArn: aws.String(p.topicPurchase),
			Message:  aws.String(string(data)),
			MessageAttributes: map[string]snstypes.MessageAttributeValue{
				"event_type": {
					DataType:    aws.String("String"),
					StringValue: aws.String("order.created"),
				},
			},
		})
		if err != nil {
			log.Printf("[SNS] Failed to publish purchase event: %v", err)
		}
	}()
}

// PublishSeatHoldAsync publishes a seat hold/release event to SNS in a goroutine.
func (p *Publisher) PublishSeatHoldAsync(event SeatHoldEvent) {
	if !p.enabled || p.topicSeatHold == "" {
		return
	}
	go func() {
		eventType := "seat.held"
		if event.Action == "release" {
			eventType = "seat.released"
		}
		env := newEnvelope(eventType, event)
		data, err := json.Marshal(env)
		if err != nil {
			log.Printf("[SNS] Failed to marshal seat hold event: %v", err)
			return
		}
		_, err = p.client.Publish(context.Background(), &sns.PublishInput{
			TopicArn: aws.String(p.topicSeatHold),
			Message:  aws.String(string(data)),
			MessageAttributes: map[string]snstypes.MessageAttributeValue{
				"event_type": {
					DataType:    aws.String("String"),
					StringValue: aws.String(eventType),
				},
			},
		})
		if err != nil {
			log.Printf("[SNS] Failed to publish seat hold event: %v", err)
		}
	}()
}

// PublishAdmissionAsync publishes an admission event to SNS in a goroutine.
func (p *Publisher) PublishAdmissionAsync(message string) {
	if !p.enabled || p.topicAdmission == "" {
		return
	}
	go func() {
		env := newEnvelope("admission.update", map[string]string{"message": message})
		data, err := json.Marshal(env)
		if err != nil {
			log.Printf("[SNS] Failed to marshal admission event: %v", err)
			return
		}
		_, err = p.client.Publish(context.Background(), &sns.PublishInput{
			TopicArn: aws.String(p.topicAdmission),
			Message:  aws.String(string(data)),
			MessageAttributes: map[string]snstypes.MessageAttributeValue{
				"event_type": {
					DataType:    aws.String("String"),
					StringValue: aws.String("admission.update"),
				},
			},
		})
		if err != nil {
			log.Printf("[SNS] Failed to publish admission event: %v", err)
		}
	}()
}
