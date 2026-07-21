import csv, io, re, os
from datetime import datetime, timedelta
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Request, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func
from jose import JWTError
from urllib.parse import quote
import httpx

from database import get_db
from auth import hash_password, verify_password, decode_token, create_token
from models import (User, AttendanceLog, GPSPing, Task, Message, ChatRoom, ChatMember,
                    Leave, LeaveBalance, PushToken, RefreshToken, Client, Site)
from vendor_models import (
    Company, VendorAdmin, Plan, Invoice, Payment, PromoCode,
    Announcement, SupportTicket, TicketReply, AuditLog,
    LoginActivity, CompanyNote, ScheduledAction,
)

router = APIRouter(prefix="/api/vendor", tags=["vendor"])

VENDOR_JWT_TYPE = "vendor"


# ── Auth helpers ──────────────────────────────────────────────────────────────

def get_vendor(authorization: Optional[str] = Header(None), db: Session = Depends(get_db)) -> VendorAdmin:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    try:
        payload = decode_token(authorization.split(" ", 1)[1])
        if payload.get("type") != VENDOR_JWT_TYPE:
            raise HTTPException(403, "Not a vendor token")
        vid = payload.get("sub")
    except JWTError:
        raise HTTPException(401, "Invalid or expired token")
    v = db.query(VendorAdmin).filter(VendorAdmin.id == vid, VendorAdmin.is_active == True).first()
    if not v:
        raise HTTPException(401, "Vendor not found")
    return v


def _audit(db: Session, vendor: VendorAdmin, action: str, resource: str = None,
           resource_id: str = None, details: dict = None, ip: str = None):
    db.add(AuditLog(
        vendor_admin_id=vendor.id, action=action, resource=resource,
        resource_id=resource_id, details=details, ip_address=ip,
    ))
    db.commit()


def _company_status(c: Company) -> str:
    if c.is_suspended:
        return "suspended"
    if not c.is_active:
        return "inactive"
    now = datetime.utcnow()
    if c.plan == "trial":
        if c.trial_end and now > c.trial_end:
            return "expired"
        return "trial"
    if c.expires_at:
        grace = c.expires_at + timedelta(days=c.grace_days or 3)
        if now > grace:
            return "expired"
        if now > c.expires_at:
            return "grace"
    return "active"


def _days_left(c: Company) -> int:
    now = datetime.utcnow()
    end = c.trial_end if c.plan == "trial" else c.expires_at
    if not end:
        return 9999
    return max(0, (end - now).days)


def _company_dict(c: Company, db: Session) -> dict:
    user_count = db.query(func.count(User.id)).filter(User.is_active == True).scalar() or 0
    onboarding = sum([
        c.onboarding_admin_logged_in,
        c.onboarding_employee_added,
        c.onboarding_first_punch,
    ])
    return {
        "id": c.id, "name": c.name, "slug": c.slug,
        "contact_name": c.contact_name, "contact_email": c.contact_email,
        "contact_phone": c.contact_phone,
        "plan": c.plan, "max_users": c.max_users,
        "trial_start": c.trial_start.isoformat() if c.trial_start else None,
        "trial_end": c.trial_end.isoformat() if c.trial_end else None,
        "expires_at": c.expires_at.isoformat() if c.expires_at else None,
        "grace_days": c.grace_days,
        "status": _company_status(c),
        "days_left": _days_left(c),
        "is_active": c.is_active, "is_suspended": c.is_suspended,
        "suspension_reason": c.suspension_reason,
        "auto_renew": c.auto_renew, "discount_percent": c.discount_percent,
        "feature_gps": c.feature_gps, "feature_chat": c.feature_chat,
        "feature_leave": c.feature_leave, "feature_reports": c.feature_reports,
        "logo_url": c.logo_url,
        "working_hours_start": c.working_hours_start,
        "working_hours_end": c.working_hours_end,
        "gps_ping_interval": c.gps_ping_interval,
        "ip_whitelist": c.ip_whitelist or [],
        "require_2fa": c.require_2fa,
        "tags": c.tags or [],
        "geo_fence_enabled": c.geo_fence_enabled or False,
        "office_name": c.office_name,
        "office_lat": c.office_lat,
        "office_lng": c.office_lng,
        "office_radius_m": c.office_radius_m or 100,
        "onboarding_score": onboarding,
        "onboarding_admin_logged_in": c.onboarding_admin_logged_in,
        "onboarding_employee_added": c.onboarding_employee_added,
        "onboarding_first_punch": c.onboarding_first_punch,
        "user_count": user_count,
        "created_at": c.created_at.isoformat(),
    }


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _next_invoice_number(db: Session) -> str:
    count = db.query(func.count(Invoice.id)).scalar() or 0
    return f"INV-{(count + 1):05d}"


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class VendorLoginIn(BaseModel):
    email: str
    password: str

class CompanyIn(BaseModel):
    name: str
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    plan: str = "trial"
    max_users: int = 10
    trial_days: int = 15
    expires_at: Optional[str] = None
    grace_days: int = 3
    auto_renew: bool = False
    discount_percent: float = 0.0
    feature_gps: bool = True
    feature_chat: bool = True
    feature_leave: bool = True
    feature_reports: bool = True
    working_hours_start: Optional[str] = None
    working_hours_end: Optional[str] = None
    gps_ping_interval: int = 30
    require_2fa: bool = False
    tags: Optional[List[str]] = None
    initial_password: Optional[str] = None
    geo_fence_enabled: bool = False
    office_name: Optional[str] = None
    office_lat: Optional[float] = None
    office_lng: Optional[float] = None
    office_radius_m: int = 100

class CompanyUpdateIn(BaseModel):
    name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    plan: Optional[str] = None
    max_users: Optional[int] = None
    expires_at: Optional[str] = None
    grace_days: Optional[int] = None
    auto_renew: Optional[bool] = None
    discount_percent: Optional[float] = None
    feature_gps: Optional[bool] = None
    feature_chat: Optional[bool] = None
    feature_leave: Optional[bool] = None
    feature_reports: Optional[bool] = None
    working_hours_start: Optional[str] = None
    working_hours_end: Optional[str] = None
    gps_ping_interval: Optional[int] = None
    require_2fa: Optional[bool] = None
    tags: Optional[List[str]] = None
    geo_fence_enabled: Optional[bool] = None
    office_name: Optional[str] = None
    office_lat: Optional[float] = None
    office_lng: Optional[float] = None
    office_radius_m: Optional[int] = None

class ExtendIn(BaseModel):
    days: int = 30

class SuspendIn(BaseModel):
    reason: Optional[str] = None

class InvoiceIn(BaseModel):
    company_id: str
    amount: float
    plan: str
    period_start: str
    period_end: str
    notes: Optional[str] = None

class PaymentIn(BaseModel):
    company_id: str
    invoice_id: Optional[str] = None
    amount: float
    method: Optional[str] = None
    reference: Optional[str] = None
    notes: Optional[str] = None

class PromoIn(BaseModel):
    code: str
    discount_percent: float
    max_uses: Optional[int] = None
    expires_at: Optional[str] = None

class AnnouncementIn(BaseModel):
    title: str
    message: str
    target: str = "all"
    company_ids: Optional[List[str]] = None

class TicketReplyIn(BaseModel):
    message: str

class TicketUpdateIn(BaseModel):
    status: Optional[str] = None
    priority: Optional[str] = None

class NoteIn(BaseModel):
    note: str

class ScheduledActionIn(BaseModel):
    company_id: str
    action: str
    scheduled_at: str
    notes: Optional[str] = None

class UserTransferIn(BaseModel):
    target_company_id: str

class PlanIn(BaseModel):
    name: str
    display_name: str
    price_monthly: float
    max_users: int
    feature_gps: bool = True
    feature_chat: bool = True
    feature_leave: bool = True
    feature_reports: bool = True

class BulkActionIn(BaseModel):
    company_ids: List[str]
    action: str   # extend30 / suspend / activate / delete
    reason: Optional[str] = None


# ── Auth ──────────────────────────────────────────────────────────────────────

@router.post("/auth/login")
def vendor_login(body: VendorLoginIn, db: Session = Depends(get_db)):
    v = db.query(VendorAdmin).filter(VendorAdmin.email == body.email, VendorAdmin.is_active == True).first()
    if not v or not verify_password(body.password, v.password):
        raise HTTPException(401, "Invalid credentials")
    token = create_token({"sub": v.id, "type": VENDOR_JWT_TYPE, "name": v.name})
    return {"access_token": token, "vendor": {"id": v.id, "name": v.name, "email": v.email}}


@router.get("/auth/me")
def vendor_me(v: VendorAdmin = Depends(get_vendor)):
    return {"id": v.id, "name": v.name, "email": v.email}


# ── Companies ─────────────────────────────────────────────────────────────────

@router.get("/companies")
def list_companies(
    q: Optional[str] = None,
    status: Optional[str] = None,
    plan: Optional[str] = None,
    tag: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    v: VendorAdmin = Depends(get_vendor),
):
    query = db.query(Company)
    if q:
        query = query.filter(Company.name.ilike(f"%{q}%"))
    if plan:
        query = query.filter(Company.plan == plan)
    companies = query.order_by(Company.created_at.desc()).offset(offset).limit(limit).all()
    result = [_company_dict(c, db) for c in companies]
    if status:
        result = [r for r in result if r["status"] == status]
    if tag:
        result = [r for r in result if tag in (r.get("tags") or [])]
    return result


@router.post("/companies")
def create_company(body: CompanyIn, request: Request, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    base_slug = _slug(body.name)
    slug = base_slug
    i = 1
    while db.query(Company).filter(Company.slug == slug).first():
        slug = f"{base_slug}-{i}"
        i += 1

    now = datetime.utcnow()
    trial_end = now + timedelta(days=body.trial_days) if body.plan == "trial" else None
    expires_at = datetime.fromisoformat(body.expires_at) if body.expires_at else None

    c = Company(
        name=body.name, slug=slug,
        contact_name=body.contact_name, contact_email=body.contact_email,
        contact_phone=body.contact_phone,
        plan=body.plan, max_users=body.max_users,
        trial_start=now if body.plan == "trial" else None,
        trial_end=trial_end, expires_at=expires_at,
        grace_days=body.grace_days, auto_renew=body.auto_renew,
        discount_percent=body.discount_percent,
        feature_gps=body.feature_gps, feature_chat=body.feature_chat,
        feature_leave=body.feature_leave, feature_reports=body.feature_reports,
        working_hours_start=body.working_hours_start, working_hours_end=body.working_hours_end,
        gps_ping_interval=body.gps_ping_interval, require_2fa=body.require_2fa,
        tags=body.tags,
    )
    db.add(c)
    db.commit()
    db.refresh(c)

    # Create admin user for the company if password provided
    if body.initial_password and body.contact_email:
        existing = db.query(User).filter(User.email == body.contact_email).first()
        if not existing:
            admin_user = User(
                name=body.contact_name or body.name,
                email=body.contact_email,
                password=hash_password(body.initial_password),
                plain_password=body.initial_password,
                role="admin",
                company_id=c.id,
            )
            db.add(admin_user)
            db.commit()
            db.refresh(admin_user)
            # Create a default group chat room for this company
            room = ChatRoom(name=f"{c.name} General", room_type="group")
            db.add(room)
            db.commit()
            db.refresh(room)
            db.add(ChatMember(room_id=room.id, user_id=admin_user.id))
            db.commit()

    _audit(db, v, "create_company", "company", c.id, {"name": c.name}, request.client.host)
    return _company_dict(c, db)


@router.get("/companies/{company_id}")
def get_company(company_id: str, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    return _company_dict(c, db)


@router.put("/companies/{company_id}")
def update_company(company_id: str, body: CompanyUpdateIn, request: Request,
                   db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    fields = body.dict(exclude_none=True)
    if "expires_at" in fields and fields["expires_at"]:
        fields["expires_at"] = datetime.fromisoformat(fields["expires_at"])
    for k, val in fields.items():
        setattr(c, k, val)
    c.updated_at = datetime.utcnow()
    db.commit()
    _audit(db, v, "update_company", "company", c.id, fields, request.client.host)
    return _company_dict(c, db)


@router.delete("/companies/{company_id}")
def delete_company(company_id: str, request: Request,
                   db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    name = c.name
    # Cascade: delete all operational data for this company's users
    user_ids = [r[0] for r in db.query(User.id).filter(User.company_id == company_id).all()]
    if user_ids:
        db.query(ChatMember).filter(ChatMember.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(Message).filter(Message.sender_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(GPSPing).filter(GPSPing.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(AttendanceLog).filter(AttendanceLog.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(LeaveBalance).filter(LeaveBalance.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(Leave).filter(Leave.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(PushToken).filter(PushToken.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(RefreshToken).filter(RefreshToken.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(Task).filter(Task.company_id == company_id).delete(synchronize_session=False)
        db.query(Client).filter(Client.company_id == company_id).delete(synchronize_session=False)
        db.query(Site).filter(Site.company_id == company_id).delete(synchronize_session=False)
        db.query(User).filter(User.company_id == company_id).delete(synchronize_session=False)
    db.delete(c)
    db.commit()
    _audit(db, v, "delete_company", "company", company_id, {"name": name}, request.client.host)
    return {"ok": True, "deleted_users": len(user_ids)}


@router.post("/companies/{company_id}/extend")
def extend_company(company_id: str, body: ExtendIn, request: Request,
                   db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    now = datetime.utcnow()
    if c.plan == "trial":
        base = c.trial_end if (c.trial_end and c.trial_end > now) else now
        c.trial_end = base + timedelta(days=body.days)
    else:
        base = c.expires_at if (c.expires_at and c.expires_at > now) else now
        c.expires_at = base + timedelta(days=body.days)
    if _company_status(c) == "expired":
        c.is_active = True
        c.is_suspended = False
    c.updated_at = datetime.utcnow()
    db.commit()
    _audit(db, v, "extend_company", "company", c.id, {"days": body.days}, request.client.host)
    return _company_dict(c, db)


@router.post("/companies/{company_id}/suspend")
def suspend_company(company_id: str, body: SuspendIn, request: Request,
                    db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    c.is_suspended = True
    c.suspension_reason = body.reason
    c.updated_at = datetime.utcnow()
    # Deactivate all company users so they can't log in
    db.query(User).filter(User.company_id == company_id).update(
        {"is_active": False}, synchronize_session=False
    )
    db.commit()
    _audit(db, v, "suspend_company", "company", c.id, {"reason": body.reason}, request.client.host)
    return _company_dict(c, db)


@router.post("/companies/{company_id}/activate")
def activate_company(company_id: str, request: Request,
                     db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    c.is_suspended = False
    c.is_active = True
    c.suspension_reason = None
    c.updated_at = datetime.utcnow()
    # Re-enable all company users
    db.query(User).filter(User.company_id == company_id).update(
        {"is_active": True}, synchronize_session=False
    )
    db.commit()
    _audit(db, v, "activate_company", "company", c.id, {}, request.client.host)
    return _company_dict(c, db)


@router.post("/companies/{company_id}/clone")
def clone_company(company_id: str, request: Request,
                  db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    src = db.query(Company).filter(Company.id == company_id).first()
    if not src:
        raise HTTPException(404, "Company not found")
    base_name = f"{src.name} (Copy)"
    base_slug = _slug(base_name)
    slug = base_slug
    i = 1
    while db.query(Company).filter(Company.slug == slug).first():
        slug = f"{base_slug}-{i}"
        i += 1
    now = datetime.utcnow()
    c = Company(
        name=base_name, slug=slug,
        contact_name=src.contact_name, contact_email=src.contact_email,
        contact_phone=src.contact_phone,
        plan="trial", max_users=src.max_users,
        trial_start=now, trial_end=now + timedelta(days=15),
        grace_days=src.grace_days, auto_renew=src.auto_renew,
        discount_percent=src.discount_percent,
        feature_gps=src.feature_gps, feature_chat=src.feature_chat,
        feature_leave=src.feature_leave, feature_reports=src.feature_reports,
        working_hours_start=src.working_hours_start, working_hours_end=src.working_hours_end,
        gps_ping_interval=src.gps_ping_interval, require_2fa=src.require_2fa,
        tags=src.tags,
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    _audit(db, v, "clone_company", "company", c.id, {"source": company_id}, request.client.host)
    return _company_dict(c, db)


@router.get("/companies/{company_id}/stats")
def company_stats(company_id: str, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    now = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    total_users  = db.query(func.count(User.id)).filter(User.is_active == True).scalar() or 0
    punches_month = db.query(func.count(AttendanceLog.id)).filter(AttendanceLog.punch_in_time >= month_start).scalar() or 0
    gps_today    = db.query(func.count(GPSPing.id)).filter(GPSPing.created_at >= now.replace(hour=0,minute=0,second=0,microsecond=0)).scalar() or 0
    tasks_total  = db.query(func.count(Task.id)).scalar() or 0
    notes_list   = [{"id": n.id, "note": n.note, "created_by": n.created_by, "created_at": n.created_at.isoformat()} for n in c.notes]
    return {
        "company": _company_dict(c, db),
        "total_users": total_users,
        "punches_this_month": punches_month,
        "gps_pings_today": gps_today,
        "tasks_total": tasks_total,
        "notes": notes_list,
        "invoices_count": len(c.invoices),
        "payments_total": sum(p.amount for p in c.payments),
        "open_tickets": sum(1 for t in c.tickets if t.status == "open"),
    }


@router.post("/companies/{company_id}/seed-demo")
def seed_demo(company_id: str, request: Request,
              db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    now = datetime.utcnow()
    demo_users = [
        {"name": "Demo Admin", "email": f"admin@{c.slug}.demo", "role": "admin"},
        {"name": "Field Worker 1", "email": f"worker1@{c.slug}.demo", "role": "field_worker"},
        {"name": "Field Worker 2", "email": f"worker2@{c.slug}.demo", "role": "field_worker"},
    ]
    created = 0
    for u in demo_users:
        if not db.query(User).filter(User.email == u["email"]).first():
            db.add(User(name=u["name"], email=u["email"],
                        password=hash_password("Demo@1234"),
                        plain_password="Demo@1234", role=u["role"],
                        company_id=company_id))
            created += 1
    db.commit()
    c.onboarding_admin_logged_in = True
    c.onboarding_employee_added  = True
    db.commit()
    _audit(db, v, "seed_demo", "company", c.id, {"users_created": created}, request.client.host)
    return {"ok": True, "users_created": created}


# ── Company Notes ─────────────────────────────────────────────────────────────

@router.get("/companies/{company_id}/notes")
def get_notes(company_id: str, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    return [{"id": n.id, "note": n.note, "created_by": n.created_by, "created_at": n.created_at.isoformat()} for n in sorted(c.notes, key=lambda x: x.created_at, reverse=True)]


@router.post("/companies/{company_id}/notes")
def add_note(company_id: str, body: NoteIn, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    n = CompanyNote(company_id=company_id, note=body.note, created_by=v.name)
    db.add(n)
    db.commit()
    db.refresh(n)
    return {"id": n.id, "note": n.note, "created_by": n.created_by, "created_at": n.created_at.isoformat()}


@router.delete("/companies/{company_id}/notes/{note_id}")
def delete_note(company_id: str, note_id: str, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    n = db.query(CompanyNote).filter(CompanyNote.id == note_id, CompanyNote.company_id == company_id).first()
    if not n:
        raise HTTPException(404, "Note not found")
    db.delete(n)
    db.commit()
    return {"ok": True}


# ── Bulk Actions ──────────────────────────────────────────────────────────────

@router.post("/companies/bulk-action")
def bulk_action(body: BulkActionIn, request: Request,
                db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    results = []
    for cid in body.company_ids:
        c = db.query(Company).filter(Company.id == cid).first()
        if not c:
            results.append({"id": cid, "ok": False, "error": "not found"})
            continue
        if body.action == "extend30":
            now = datetime.utcnow()
            if c.plan == "trial":
                base = c.trial_end if (c.trial_end and c.trial_end > now) else now
                c.trial_end = base + timedelta(days=30)
            else:
                base = c.expires_at if (c.expires_at and c.expires_at > now) else now
                c.expires_at = base + timedelta(days=30)
        elif body.action == "suspend":
            c.is_suspended = True
            c.suspension_reason = body.reason
        elif body.action == "activate":
            c.is_suspended = False
            c.is_active = True
            c.suspension_reason = None
        elif body.action == "delete":
            db.delete(c)
            results.append({"id": cid, "ok": True})
            continue
        c.updated_at = datetime.utcnow()
        results.append({"id": cid, "ok": True})
    db.commit()
    _audit(db, v, f"bulk_{body.action}", "companies", None, {"ids": body.company_ids}, request.client.host)
    return results


# ── Plans ─────────────────────────────────────────────────────────────────────

@router.get("/plans")
def list_plans(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    return [{"id": p.id, "name": p.name, "display_name": p.display_name,
             "price_monthly": p.price_monthly, "max_users": p.max_users,
             "feature_gps": p.feature_gps, "feature_chat": p.feature_chat,
             "feature_leave": p.feature_leave, "feature_reports": p.feature_reports,
             "is_active": p.is_active} for p in db.query(Plan).all()]


@router.post("/plans")
def create_plan(body: PlanIn, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    p = Plan(**body.dict())
    db.add(p)
    db.commit()
    db.refresh(p)
    return {"id": p.id, "name": p.name}


# ── Invoices ──────────────────────────────────────────────────────────────────

@router.get("/invoices")
def list_invoices(company_id: Optional[str] = None, status: Optional[str] = None,
                  db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    q = db.query(Invoice)
    if company_id:
        q = q.filter(Invoice.company_id == company_id)
    if status:
        q = q.filter(Invoice.status == status)
    invoices = q.order_by(Invoice.created_at.desc()).all()
    return [{
        "id": i.id, "company_id": i.company_id,
        "company_name": i.company.name if i.company else "",
        "invoice_number": i.invoice_number,
        "amount": i.amount, "discount_amount": i.discount_amount,
        "final_amount": i.final_amount, "plan": i.plan,
        "period_start": i.period_start.isoformat(),
        "period_end": i.period_end.isoformat(),
        "status": i.status,
        "paid_at": i.paid_at.isoformat() if i.paid_at else None,
        "notes": i.notes,
        "created_at": i.created_at.isoformat(),
    } for i in invoices]


@router.post("/invoices")
def create_invoice(body: InvoiceIn, request: Request,
                   db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == body.company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    disc = body.amount * (c.discount_percent / 100)
    inv = Invoice(
        company_id=body.company_id,
        invoice_number=_next_invoice_number(db),
        amount=body.amount, discount_amount=disc,
        final_amount=round(body.amount - disc, 2),
        plan=body.plan,
        period_start=datetime.fromisoformat(body.period_start),
        period_end=datetime.fromisoformat(body.period_end),
        notes=body.notes,
    )
    db.add(inv)
    db.commit()
    db.refresh(inv)
    _audit(db, v, "create_invoice", "invoice", inv.id, {"company": c.name, "amount": inv.final_amount}, request.client.host)
    return {"id": inv.id, "invoice_number": inv.invoice_number, "final_amount": inv.final_amount}


@router.post("/invoices/{invoice_id}/mark-paid")
def mark_invoice_paid(invoice_id: str, request: Request,
                      db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    inv.status = "paid"
    inv.paid_at = datetime.utcnow()
    db.commit()
    _audit(db, v, "mark_invoice_paid", "invoice", invoice_id, {}, request.client.host)
    return {"ok": True}


@router.delete("/invoices/{invoice_id}")
def delete_invoice(invoice_id: str, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    db.delete(inv)
    db.commit()
    return {"ok": True}


# ── Payments ──────────────────────────────────────────────────────────────────

@router.get("/payments")
def list_payments(company_id: Optional[str] = None,
                  db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    q = db.query(Payment)
    if company_id:
        q = q.filter(Payment.company_id == company_id)
    payments = q.order_by(Payment.paid_at.desc()).all()
    return [{
        "id": p.id, "company_id": p.company_id,
        "company_name": p.company.name if p.company else "",
        "invoice_id": p.invoice_id, "amount": p.amount,
        "method": p.method, "reference": p.reference,
        "notes": p.notes, "paid_at": p.paid_at.isoformat(),
    } for p in payments]


@router.post("/payments")
def record_payment(body: PaymentIn, request: Request,
                   db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == body.company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    p = Payment(**body.dict())
    db.add(p)
    if body.invoice_id:
        inv = db.query(Invoice).filter(Invoice.id == body.invoice_id).first()
        if inv:
            inv.status = "paid"
            inv.paid_at = datetime.utcnow()
    db.commit()
    db.refresh(p)
    _audit(db, v, "record_payment", "payment", p.id, {"company": c.name, "amount": p.amount}, request.client.host)
    return {"id": p.id, "ok": True}


# ── Promo Codes ───────────────────────────────────────────────────────────────

@router.get("/promo-codes")
def list_promos(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    return [{
        "id": p.id, "code": p.code, "discount_percent": p.discount_percent,
        "max_uses": p.max_uses, "used_count": p.used_count,
        "expires_at": p.expires_at.isoformat() if p.expires_at else None,
        "is_active": p.is_active, "created_at": p.created_at.isoformat(),
    } for p in db.query(PromoCode).order_by(PromoCode.created_at.desc()).all()]


@router.post("/promo-codes")
def create_promo(body: PromoIn, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    existing = db.query(PromoCode).filter(PromoCode.code == body.code.upper()).first()
    if existing:
        raise HTTPException(400, "Promo code already exists")
    p = PromoCode(
        code=body.code.upper(),
        discount_percent=body.discount_percent,
        max_uses=body.max_uses,
        expires_at=datetime.fromisoformat(body.expires_at) if body.expires_at else None,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return {"id": p.id, "code": p.code}


@router.delete("/promo-codes/{promo_id}")
def delete_promo(promo_id: str, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    p = db.query(PromoCode).filter(PromoCode.id == promo_id).first()
    if not p:
        raise HTTPException(404, "Promo code not found")
    db.delete(p)
    db.commit()
    return {"ok": True}


# ── Revenue / Analytics ───────────────────────────────────────────────────────

@router.get("/revenue")
def revenue_stats(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    now = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_month_start = (month_start - timedelta(days=1)).replace(day=1)
    all_payments = db.query(Payment).all()
    month_rev   = sum(p.amount for p in all_payments if p.paid_at >= month_start)
    last_rev    = sum(p.amount for p in all_payments if last_month_start <= p.paid_at < month_start)
    total_rev   = sum(p.amount for p in all_payments)
    companies   = db.query(Company).all()
    active_cos  = [c for c in companies if _company_status(c) == "active"]
    plans_rev   = db.query(Plan).all()
    plan_map    = {p.name: p.price_monthly for p in plans_rev}
    mrr = sum(plan_map.get(c.plan, 0) * (1 - c.discount_percent/100) for c in active_cos)
    monthly_data = {}
    for p in all_payments:
        key = p.paid_at.strftime("%Y-%m")
        monthly_data[key] = monthly_data.get(key, 0) + p.amount
    return {
        "mrr": round(mrr, 2),
        "arr": round(mrr * 12, 2),
        "month_revenue": round(month_rev, 2),
        "last_month_revenue": round(last_rev, 2),
        "total_revenue": round(total_rev, 2),
        "active_companies": len(active_cos),
        "monthly_chart": [{"month": k, "amount": round(v, 2)} for k, v in sorted(monthly_data.items())[-12:]],
    }


@router.get("/analytics/dashboard")
def analytics_dashboard(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    now = datetime.utcnow()
    companies = db.query(Company).all()
    statuses = {"trial": 0, "active": 0, "expired": 0, "suspended": 0, "grace": 0}
    expiring_soon = []
    for c in companies:
        s = _company_status(c)
        statuses[s] = statuses.get(s, 0) + 1
        dl = _days_left(c)
        if 0 < dl <= 7 and s in ("trial", "active", "grace"):
            expiring_soon.append({"id": c.id, "name": c.name, "days_left": dl, "plan": c.plan})
    total_users = db.query(func.count(User.id)).filter(User.is_active == True).scalar() or 0
    punches_today = db.query(func.count(AttendanceLog.id)).filter(
        AttendanceLog.punch_in_time >= now.replace(hour=0, minute=0, second=0, microsecond=0)
    ).scalar() or 0
    open_tickets = db.query(func.count(SupportTicket.id)).filter(SupportTicket.status == "open").scalar() or 0
    return {
        "total_companies": len(companies),
        "statuses": statuses,
        "expiring_soon": sorted(expiring_soon, key=lambda x: x["days_left"]),
        "total_users": total_users,
        "punches_today": punches_today,
        "open_tickets": open_tickets,
        "new_this_month": sum(1 for c in companies if c.created_at >= now.replace(day=1,hour=0,minute=0,second=0,microsecond=0)),
    }


@router.get("/analytics/usage")
def analytics_usage(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    now = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    week_ago = now - timedelta(days=7)
    companies = db.query(Company).all()
    result = []
    for c in companies:
        gps_count    = db.query(func.count(GPSPing.id)).filter(GPSPing.created_at >= month_start).scalar() or 0
        punch_count  = db.query(func.count(AttendanceLog.id)).filter(AttendanceLog.punch_in_time >= month_start).scalar() or 0
        task_count   = db.query(func.count(Task.id)).scalar() or 0
        active_users = db.query(func.count(User.id)).filter(User.is_active == True).scalar() or 0
        last_activity = db.query(func.max(AttendanceLog.punch_in_time)).scalar()
        dormant = last_activity is None or last_activity < week_ago
        result.append({
            "id": c.id, "name": c.name, "plan": c.plan,
            "status": _company_status(c),
            "active_users": active_users,
            "gps_pings_month": gps_count,
            "punches_month": punch_count,
            "tasks_total": task_count,
            "last_activity": last_activity.isoformat() if last_activity else None,
            "is_dormant": dormant,
            "feature_gps": c.feature_gps, "feature_chat": c.feature_chat,
            "feature_leave": c.feature_leave, "feature_reports": c.feature_reports,
        })
    return sorted(result, key=lambda x: x["punches_month"], reverse=True)


@router.get("/analytics/dormant")
def dormant_companies(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    week_ago = datetime.utcnow() - timedelta(days=7)
    companies = db.query(Company).filter(Company.is_active == True, Company.is_suspended == False).all()
    dormant = []
    for c in companies:
        last = db.query(func.max(AttendanceLog.punch_in_time)).scalar()
        if last is None or last < week_ago:
            dormant.append({"id": c.id, "name": c.name, "plan": c.plan,
                            "last_activity": last.isoformat() if last else None})
    return dormant


# ── User Management ───────────────────────────────────────────────────────────

@router.get("/users")
def list_all_users(q: Optional[str] = None, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    query = db.query(User)
    if q:
        query = query.filter(User.name.ilike(f"%{q}%") | User.email.ilike(f"%{q}%"))
    users = query.order_by(User.created_at.desc()).all()
    return [{
        "id": u.id, "name": u.name, "email": u.email,
        "role": u.role, "is_active": u.is_active,
        "created_at": u.created_at.isoformat(),
    } for u in users]


@router.post("/users")
def create_user(body: dict, request: Request, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    if db.query(User).filter(User.email == body.get("email")).first():
        raise HTTPException(400, "Email already exists")
    u = User(
        name=body.get("name"),
        email=body.get("email"),
        password=hash_password(body.get("password")),
        plain_password=body.get("password"),
        role=body.get("role", "field_worker"),
        company_id=body.get("company_id", "default"),
        is_active=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    _audit(db, v, "create_user", "user", u.id, {"email": u.email, "role": u.role}, request.client.host)
    return {"id": u.id, "name": u.name, "email": u.email, "role": u.role, "is_active": u.is_active, "created_at": u.created_at.isoformat()}


@router.post("/users/{user_id}/block")
def block_user(user_id: str, request: Request,
               db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    u.is_active = not u.is_active
    db.commit()
    action = "unblock_user" if u.is_active else "block_user"
    _audit(db, v, action, "user", user_id, {"email": u.email}, request.client.host)
    return {"id": u.id, "is_active": u.is_active}


@router.post("/users/{user_id}/force-reset")
def force_reset(user_id: str, request: Request,
                db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    new_pass = "Reset@" + str(datetime.utcnow().strftime("%d%m"))
    u.password = hash_password(new_pass)
    u.plain_password = new_pass
    db.commit()
    _audit(db, v, "force_reset", "user", user_id, {"email": u.email}, request.client.host)
    return {"ok": True, "temp_password": new_pass}


@router.post("/users/{user_id}/impersonate")
def impersonate_user(user_id: str, request: Request,
                     db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    token = create_token({"sub": u.id, "role": u.role, "impersonated_by": v.id})
    _audit(db, v, "impersonate_user", "user", user_id, {"email": u.email}, request.client.host)
    return {"access_token": token, "user": {"id": u.id, "name": u.name, "email": u.email, "role": u.role}}


@router.delete("/users/{user_id}")
def delete_user(user_id: str, request: Request,
                db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    email = u.email
    db.query(AttendanceLog).filter(AttendanceLog.user_id == user_id).delete()
    db.query(GPSPing).filter(GPSPing.user_id == user_id).delete()
    db.query(Task).filter(Task.assignee_id == user_id).delete()
    db.query(LeaveBalance).filter(LeaveBalance.user_id == user_id).delete()
    db.query(PushToken).filter(PushToken.user_id == user_id).delete()
    db.query(RefreshToken).filter(RefreshToken.user_id == user_id).delete()
    db.delete(u)
    db.commit()
    _audit(db, v, "delete_user", "user", user_id, {"email": email}, request.client.host)
    return {"ok": True}


# ── Announcements ─────────────────────────────────────────────────────────────

@router.get("/announcements")
def list_announcements(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    return [{
        "id": a.id, "title": a.title, "message": a.message,
        "target": a.target, "company_ids": a.company_ids,
        "sent_at": a.sent_at.isoformat(), "sent_by": a.sent_by,
    } for a in db.query(Announcement).order_by(Announcement.sent_at.desc()).all()]


@router.post("/announcements")
def create_announcement(body: AnnouncementIn, request: Request,
                        db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    a = Announcement(
        title=body.title, message=body.message,
        target=body.target, company_ids=body.company_ids,
        sent_by=v.name,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    _audit(db, v, "send_announcement", "announcement", a.id, {"title": a.title}, request.client.host)
    return {"id": a.id, "ok": True}


@router.delete("/announcements/{ann_id}")
def delete_announcement(ann_id: str, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    a = db.query(Announcement).filter(Announcement.id == ann_id).first()
    if not a:
        raise HTTPException(404, "Not found")
    db.delete(a)
    db.commit()
    return {"ok": True}


# ── Support Tickets ───────────────────────────────────────────────────────────

@router.get("/tickets")
def list_tickets(status: Optional[str] = None, company_id: Optional[str] = None,
                 db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    q = db.query(SupportTicket)
    if status:
        q = q.filter(SupportTicket.status == status)
    if company_id:
        q = q.filter(SupportTicket.company_id == company_id)
    tickets = q.order_by(SupportTicket.created_at.desc()).all()
    return [{
        "id": t.id, "company_id": t.company_id,
        "company_name": t.company.name if t.company else "",
        "title": t.title, "description": t.description,
        "status": t.status, "priority": t.priority,
        "reply_count": len(t.replies),
        "created_at": t.created_at.isoformat(),
        "updated_at": t.updated_at.isoformat(),
    } for t in tickets]


@router.get("/tickets/{ticket_id}")
def get_ticket(ticket_id: str, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    t = db.query(SupportTicket).filter(SupportTicket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    return {
        "id": t.id, "company_id": t.company_id,
        "company_name": t.company.name if t.company else "",
        "title": t.title, "description": t.description,
        "status": t.status, "priority": t.priority,
        "replies": [{"id": r.id, "message": r.message, "is_vendor": r.is_vendor,
                     "created_at": r.created_at.isoformat()} for r in t.replies],
        "created_at": t.created_at.isoformat(),
    }


@router.post("/tickets/{ticket_id}/reply")
def reply_ticket(ticket_id: str, body: TicketReplyIn, request: Request,
                 db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    t = db.query(SupportTicket).filter(SupportTicket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    r = TicketReply(ticket_id=ticket_id, message=body.message, is_vendor=True)
    db.add(r)
    t.status = "in_progress"
    t.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(r)
    return {"id": r.id, "ok": True}


@router.put("/tickets/{ticket_id}")
def update_ticket(ticket_id: str, body: TicketUpdateIn,
                  db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    t = db.query(SupportTicket).filter(SupportTicket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    if body.status:
        t.status = body.status
    if body.priority:
        t.priority = body.priority
    t.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


# ── Scheduled Actions ─────────────────────────────────────────────────────────

@router.get("/scheduled-actions")
def list_scheduled(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    return [{
        "id": sa.id, "company_id": sa.company_id,
        "company_name": sa.company.name if sa.company else "",
        "action": sa.action, "scheduled_at": sa.scheduled_at.isoformat(),
        "is_executed": sa.is_executed,
        "executed_at": sa.executed_at.isoformat() if sa.executed_at else None,
        "notes": sa.notes, "created_at": sa.created_at.isoformat(),
    } for sa in db.query(ScheduledAction).order_by(ScheduledAction.scheduled_at).all()]


@router.post("/scheduled-actions")
def create_scheduled(body: ScheduledActionIn, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    c = db.query(Company).filter(Company.id == body.company_id).first()
    if not c:
        raise HTTPException(404, "Company not found")
    sa = ScheduledAction(
        company_id=body.company_id, action=body.action,
        scheduled_at=datetime.fromisoformat(body.scheduled_at),
        notes=body.notes,
    )
    db.add(sa)
    db.commit()
    db.refresh(sa)
    return {"id": sa.id, "ok": True}


@router.delete("/scheduled-actions/{action_id}")
def delete_scheduled(action_id: str, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    sa = db.query(ScheduledAction).filter(ScheduledAction.id == action_id).first()
    if not sa:
        raise HTTPException(404, "Not found")
    db.delete(sa)
    db.commit()
    return {"ok": True}


# ── Audit Log ─────────────────────────────────────────────────────────────────

@router.get("/audit-logs")
def list_audit(limit: int = 100, resource: Optional[str] = None,
               db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    q = db.query(AuditLog)
    if resource:
        q = q.filter(AuditLog.resource == resource)
    logs = q.order_by(AuditLog.created_at.desc()).limit(limit).all()
    return [{
        "id": l.id, "action": l.action, "resource": l.resource,
        "resource_id": l.resource_id, "details": l.details,
        "ip_address": l.ip_address,
        "vendor_name": l.vendor_admin.name if l.vendor_admin else "System",
        "created_at": l.created_at.isoformat(),
    } for l in logs]


# ── Reports ───────────────────────────────────────────────────────────────────

@router.get("/reports/expiring")
def report_expiring(days: int = 30, db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    now = datetime.utcnow()
    cutoff = now + timedelta(days=days)
    companies = db.query(Company).all()
    result = []
    for c in companies:
        end = c.trial_end if c.plan == "trial" else c.expires_at
        if end and now < end <= cutoff:
            dl = (end - now).days
            result.append({"id": c.id, "name": c.name, "plan": c.plan,
                           "contact_email": c.contact_email, "days_left": dl,
                           "expires_at": end.isoformat()})
    return sorted(result, key=lambda x: x["days_left"])


@router.get("/reports/churn")
def report_churn(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    companies = db.query(Company).all()
    return [{"id": c.id, "name": c.name, "plan": c.plan,
             "contact_email": c.contact_email,
             "expired_at": (c.trial_end or c.expires_at).isoformat() if (c.trial_end or c.expires_at) else None,
             "created_at": c.created_at.isoformat()}
            for c in companies if _company_status(c) == "expired"]


@router.get("/reports/export-companies")
def export_companies(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    companies = db.query(Company).order_by(Company.created_at.desc()).all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["ID", "Name", "Contact", "Email", "Phone", "Plan", "Status",
                     "Days Left", "Max Users", "Auto Renew", "Discount %",
                     "GPS", "Chat", "Leave", "Reports", "Created"])
    for c in companies:
        writer.writerow([
            c.id, c.name, c.contact_name or "", c.contact_email or "",
            c.contact_phone or "", c.plan, _company_status(c), _days_left(c),
            c.max_users, c.auto_renew, c.discount_percent,
            c.feature_gps, c.feature_chat, c.feature_leave, c.feature_reports,
            c.created_at.strftime("%Y-%m-%d"),
        ])
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=companies.csv"},
    )


@router.get("/reports/revenue")
def report_revenue(db: Session = Depends(get_db), v: VendorAdmin = Depends(get_vendor)):
    payments = db.query(Payment).order_by(Payment.paid_at.desc()).all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Date", "Company", "Amount", "Method", "Reference", "Invoice"])
    for p in payments:
        writer.writerow([
            p.paid_at.strftime("%Y-%m-%d"),
            p.company.name if p.company else "",
            p.amount, p.method or "", p.reference or "", p.invoice_id or "",
        ])
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=revenue.csv"},
    )


_MAPBOX_GEO = "https://api.mapbox.com/geocoding/v5/mapbox.places"

@router.get("/geocode/search")
async def vendor_geocode_search(q: str, v: VendorAdmin = Depends(get_vendor)):
    token = os.getenv("MAPBOX_TOKEN", "")
    if not token or not q.strip():
        return []
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{_MAPBOX_GEO}/{quote(q)}.json",
            params={"access_token": token, "country": "in", "limit": 5, "language": "en"},
            timeout=5,
        )
    if r.status_code != 200:
        return []
    data = r.json()
    return [{"id": f["id"], "place_name": f["place_name"],
             "lat": f["center"][1], "lng": f["center"][0]}
            for f in data.get("features", [])]
