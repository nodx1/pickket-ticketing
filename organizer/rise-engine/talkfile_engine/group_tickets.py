"""
RISE Group Ticketing
=====================
Atomic group ticket handling: all members win together or lose together.

Group rules:
  - Max group size configurable per tier (default 4, max 10)
  - Leader submits on behalf of group
  - VCG: leader bids × group_size, quantity=group_size
  - Lottery: group = single weighted entry
  - Adjacent seating guaranteed when possible
"""

from dataclasses import dataclass, field


@dataclass
class GroupRequest:
    """Request for group ticket purchase."""
    group_id: str
    leader_user_id: str
    member_user_ids: list[str] = field(default_factory=list)  # includes leader
    tier_id: str = ""
    require_adjacent: bool = True

    @property
    def size(self) -> int:
        return len(self.member_user_ids)

    def validate(self, max_group_size: int = 4) -> tuple[bool, str]:
        """
        Validate group request.
        Returns (is_valid, reason).
        """
        if not self.group_id:
            return False, "group_id is required"
        if not self.leader_user_id:
            return False, "leader_user_id is required"
        if not self.member_user_ids:
            return False, "member_user_ids must not be empty"
        if self.leader_user_id not in self.member_user_ids:
            return False, "leader must be in member_user_ids"
        if len(self.member_user_ids) < 2:
            return False, "Group must have at least 2 members"
        if len(self.member_user_ids) > max_group_size:
            return False, f"Group size {len(self.member_user_ids)} exceeds max {max_group_size}"
        if len(set(self.member_user_ids)) != len(self.member_user_ids):
            return False, "Duplicate members in group"
        return True, "Valid"


@dataclass
class GroupResult:
    """Result of group ticket allocation."""
    group_id: str
    success: bool
    seat_ids: list[str] = field(default_factory=list)
    reason: str = ""


def validate_no_cross_group(groups: list[GroupRequest]) -> tuple[bool, str]:
    """
    Validate that no user appears in multiple groups.
    Returns (is_valid, reason).
    """
    seen_users: dict[str, str] = {}  # user_id -> group_id
    for group in groups:
        for uid in group.member_user_ids:
            if uid in seen_users:
                return False, f"User {uid} in multiple groups: {seen_users[uid]} and {group.group_id}"
            seen_users[uid] = group.group_id
    return True, "Valid"


def split_groups_and_individuals(
    user_ids: list[str],
    groups: list[GroupRequest],
) -> tuple[list[GroupRequest], list[str]]:
    """
    Split user list into groups and individuals.
    Returns (groups, individual_user_ids).
    """
    group_members: set[str] = set()
    for g in groups:
        group_members.update(g.member_user_ids)

    individuals = [uid for uid in user_ids if uid not in group_members]
    return groups, individuals
