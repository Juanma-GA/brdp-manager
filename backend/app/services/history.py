import uuid

from app.models import BRDPHistory, User


def record_change(
    db,
    brdp_id: uuid.UUID,
    user: User,
    field_name: str,
    old_value,
    new_value,
) -> None:
    """Stages a brdp_history row via db.add() -- does NOT commit, so the
    caller's own db.commit() covers the audit row and the actual field
    write atomically in one transaction. Only stages a row when the value
    genuinely changed (docs request: "UN cambio real, no un guardado") --
    None is normalized to "" so e.g. a brand-new field going from None to
    "" is correctly treated as no change.
    """
    old_str = "" if old_value is None else str(old_value)
    new_str = "" if new_value is None else str(new_value)
    if old_str == new_str:
        return
    db.add(
        BRDPHistory(
            brdp_id=brdp_id,
            user_id=user.id,
            user_email=user.email,
            field_name=field_name,
            old_value=old_str,
            new_value=new_str,
        )
    )
