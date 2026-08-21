"""Participant (domain-adaptive casting) management API."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer, get_current_user_optional
from app.models.user import User
from app.models.event import Event
from app.models.participant import ParticipantSlot, ParticipantAssignment
from app.schemas.organizer import (
    ParticipantSlotCreate,
    ParticipantSlotResponse,
    ParticipantAssignmentCreate,
    ParticipantAssignmentResponse,
)

router = APIRouter()


# ── Slots ──


@router.post(
    "/{event_id}/participants/slots", response_model=ParticipantSlotResponse, status_code=201
)
async def create_slot(
    event_id: uuid.UUID,
    data: ParticipantSlotCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a participant slot (character/position/program etc.)."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id, Event.organizer_id == user.id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    slot = ParticipantSlot(
        event_id=event_id,
        slot_name=data.slot_name,
        sort_order=data.sort_order,
    )
    db.add(slot)
    await db.commit()
    await db.refresh(slot)
    return ParticipantSlotResponse.model_validate(slot)


@router.get("/{event_id}/participants/slots", response_model=list[ParticipantSlotResponse])
async def list_slots(
    event_id: uuid.UUID,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_read_db),
):
    """List participant slots for an event (public read)."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    result = await db.execute(
        select(ParticipantSlot)
        .where(ParticipantSlot.event_id == event_id)
        .order_by(ParticipantSlot.sort_order)
    )
    slots = result.scalars().all()
    return [ParticipantSlotResponse.model_validate(s) for s in slots]


@router.delete("/{event_id}/participants/slots/{slot_id}", status_code=200)
async def delete_slot(
    event_id: uuid.UUID,
    slot_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Delete a participant slot and its assignments."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id, Event.organizer_id == user.id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    slot = (
        await db.execute(
            select(ParticipantSlot).where(
                ParticipantSlot.id == slot_id,
                ParticipantSlot.event_id == event_id,
            )
        )
    ).scalar_one_or_none()
    if not slot:
        raise HTTPException(status_code=404, detail="Slot not found")

    # Delete assignments first
    assignments = (
        (
            await db.execute(
                select(ParticipantAssignment).where(ParticipantAssignment.slot_id == slot_id)
            )
        )
        .scalars()
        .all()
    )
    for a in assignments:
        await db.delete(a)

    await db.delete(slot)
    await db.commit()
    return {"detail": "Slot deleted"}


# ── Assignments ──


@router.post(
    "/{event_id}/participants/assignments",
    response_model=ParticipantAssignmentResponse,
    status_code=201,
)
async def create_assignment(
    event_id: uuid.UUID,
    data: ParticipantAssignmentCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Assign a participant to a slot for a session date."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id, Event.organizer_id == user.id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    slot = (
        await db.execute(
            select(ParticipantSlot).where(
                ParticipantSlot.id == data.slot_id,
                ParticipantSlot.event_id == event_id,
            )
        )
    ).scalar_one_or_none()
    if not slot:
        raise HTTPException(status_code=404, detail="Slot not found")

    assignment = ParticipantAssignment(
        slot_id=data.slot_id,
        session_date=data.session_date,
        participant_name=data.participant_name,
        participant_image_url=data.participant_image_url,
        duration_minutes=data.duration_minutes,
    )
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment)
    return ParticipantAssignmentResponse.model_validate(assignment)


@router.get(
    "/{event_id}/participants/assignments", response_model=list[ParticipantAssignmentResponse]
)
async def list_assignments(
    event_id: uuid.UUID,
    slot_id: uuid.UUID | None = None,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_read_db),
):
    """List participant assignments for an event (public read)."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Get slot IDs for this event
    slot_ids_result = await db.execute(
        select(ParticipantSlot.id).where(ParticipantSlot.event_id == event_id)
    )
    slot_ids = [row[0] for row in slot_ids_result.all()]
    if not slot_ids:
        return []

    conditions = [ParticipantAssignment.slot_id.in_(slot_ids)]
    if slot_id:
        conditions.append(ParticipantAssignment.slot_id == slot_id)

    result = await db.execute(
        select(ParticipantAssignment)
        .where(*conditions)
        .order_by(ParticipantAssignment.session_date)
    )
    assignments = result.scalars().all()
    return [ParticipantAssignmentResponse.model_validate(a) for a in assignments]


@router.delete("/{event_id}/participants/assignments/{assignment_id}", status_code=200)
async def delete_assignment(
    event_id: uuid.UUID,
    assignment_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Delete a participant assignment."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id, Event.organizer_id == user.id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    assignment = (
        await db.execute(
            select(ParticipantAssignment).where(ParticipantAssignment.id == assignment_id)
        )
    ).scalar_one_or_none()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    await db.delete(assignment)
    await db.commit()
    return {"detail": "Assignment deleted"}
