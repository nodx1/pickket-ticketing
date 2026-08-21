from __future__ import annotations

import uuid
from pathlib import Path
from tempfile import gettempdir

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attendance import Attendance
from app.models.event import Event
from app.models.order import Order, OrderType
from app.models.proxy_booking import ProxyBooking


REPORT_DIR = Path(gettempdir()) / "pickket-reports"
REPORT_DIR.mkdir(parents=True, exist_ok=True)


class GovernmentReportService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def _collect_metrics(self, organizer_id: uuid.UUID) -> dict:
        total_events = (
            await self.session.execute(select(func.count(Event.id)).where(Event.organizer_id == organizer_id))
        ).scalar() or 0
        total_orders = (
            await self.session.execute(
                select(func.count(Order.id)).where(
                    Order.order_type == OrderType.PURCHASE,
                    Order.event_id.in_(select(Event.id).where(Event.organizer_id == organizer_id)),
                )
            )
        ).scalar() or 0
        total_checkins = (
            await self.session.execute(
                select(func.count(Attendance.id)).where(
                    Attendance.event_id.in_(select(Event.id).where(Event.organizer_id == organizer_id))
                )
            )
        ).scalar() or 0
        total_proxy = (
            await self.session.execute(
                select(func.count(ProxyBooking.id)).where(
                    ProxyBooking.booker_id == organizer_id
                )
            )
        ).scalar() or 0
        return {
            "total_events": int(total_events),
            "total_orders": int(total_orders),
            "total_checkins": int(total_checkins),
            "total_proxy_bookings": int(total_proxy),
        }

    async def generate_report(self, organizer_id: uuid.UUID, period: str, format: str) -> tuple[str, Path]:
        report_id = f"{organizer_id.hex}_{uuid.uuid4().hex}"
        metrics = await self._collect_metrics(organizer_id)

        if format == "xlsx":
            from openpyxl import Workbook

            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Government KPI"
            sheet.append(["metric", "value"])
            for key, value in metrics.items():
                sheet.append([key, value])
            path = REPORT_DIR / f"{report_id}.xlsx"
            workbook.save(path)
            return report_id, path

        if format == "pdf":
            from reportlab.lib.pagesizes import A4
            from reportlab.pdfgen import canvas

            path = REPORT_DIR / f"{report_id}.pdf"
            pdf = canvas.Canvas(str(path), pagesize=A4)
            pdf.setFont("Helvetica", 16)
            pdf.drawString(50, 800, f"Government KPI Report ({period})")
            pdf.setFont("Helvetica", 11)
            y = 760
            for key, value in metrics.items():
                pdf.drawString(50, y, f"{key}: {value}")
                y -= 24
            pdf.save()
            return report_id, path

        raise ValueError("Unsupported report format")
