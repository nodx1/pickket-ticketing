"""OpenTelemetry distributed tracing setup for Pickket API.

Configures TracerProvider with OTLP exporter and BatchSpanProcessor.
Only active when OTEL_ENABLED=True and OTEL_EXPORTER_ENDPOINT is set.
"""

import logging

from app.core.config import settings

logger = logging.getLogger(__name__)


def setup_telemetry() -> None:
    """Initialize OpenTelemetry tracing if enabled.

    Instruments FastAPI and SQLAlchemy automatically.
    Safe to call when dependencies are missing — logs a warning and returns.
    """
    if not settings.OTEL_ENABLED:
        logger.debug("OpenTelemetry disabled (OTEL_ENABLED=False)")
        return

    if not settings.OTEL_EXPORTER_ENDPOINT:
        logger.warning("OpenTelemetry enabled but OTEL_EXPORTER_ENDPOINT is empty; skipping setup")
        return

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.resources import Resource, SERVICE_NAME
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    except ImportError:
        logger.warning(
            "OpenTelemetry packages not installed; skipping tracing setup. "
            "Install: opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp"
        )
        return

    resource = Resource.create({SERVICE_NAME: settings.OTEL_SERVICE_NAME})
    provider = TracerProvider(resource=resource)

    exporter = OTLPSpanExporter(endpoint=settings.OTEL_EXPORTER_ENDPOINT)
    provider.add_span_processor(BatchSpanProcessor(exporter))

    trace.set_tracer_provider(provider)

    # Instrument FastAPI
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor().instrument()
        logger.info("OpenTelemetry FastAPI instrumentation ready")
    except ImportError:
        logger.debug("opentelemetry-instrumentation-fastapi not installed; skipping")

    # Instrument SQLAlchemy
    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        SQLAlchemyInstrumentor().instrument()
        logger.info("OpenTelemetry SQLAlchemy instrumentation ready")
    except ImportError:
        logger.debug("opentelemetry-instrumentation-sqlalchemy not installed; skipping")

    # Instrument Redis
    try:
        from opentelemetry.instrumentation.redis import RedisInstrumentor

        RedisInstrumentor().instrument()
        logger.info("OpenTelemetry Redis instrumentation ready")
    except ImportError:
        logger.debug("opentelemetry-instrumentation-redis not installed; skipping")

    # Instrument httpx (PortOne 결제 API 호출 등 외부 HTTP 추적)
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
        logger.info("OpenTelemetry httpx instrumentation ready")
    except ImportError:
        logger.debug("opentelemetry-instrumentation-httpx not installed; skipping")

    logger.info(
        "OpenTelemetry tracing initialized: service=%s endpoint=%s",
        settings.OTEL_SERVICE_NAME,
        settings.OTEL_EXPORTER_ENDPOINT,
    )
